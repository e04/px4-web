// Streaming FFmpeg adapter. LGPL-2.1-or-later; FFmpeg sources are pinned by build-media.mjs.
#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/channel_layout.h>
#include <libavutil/mathematics.h>
#include <libswresample/swresample.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    AVCodecContext *codec;
    AVCodecParserContext *parser;
    AVFrame *frame;
    AVFrame *filtered_frame;
    AVFilterGraph *filter_graph;
    AVFilterContext *filter_src, *filter_sink;
    int video_width, video_height, video_format;
    AVRational video_sar;
    enum AVColorSpace video_colorspace;
    enum AVColorRange video_range;
    int input_interlaced;
    double playback_pts;
    SwrContext *swr;
    double next_pts;
    int kind;
    int timestamp_initialized;
    int sample_rate, sample_format;
    AVChannelLayout layout;
} Decoder;

// Planes stay in the WASM heap; JS must copy them (into a VideoFrame) before returning.
EM_JS(void, video, (int y, int u, int v, int ys, int us, int vs, int w, int h, int display_width,
    double pts, int interlaced, int matrix, int primaries, int transfer), {
    Module.onVideo({
        heap: HEAPU8,
        layout: [{offset: y, stride: ys}, {offset: u, stride: us}, {offset: v, stride: vs}],
        width: w, height: h, displayWidth: display_width, pts, interlaced: !!interlaced,
        matrix, primaries, transfer,
    });
});
EM_JS(void, audio, (int p, int frames, double pts), {
    Module.onAudio(HEAPF32.slice(p/4, p/4+frames*2), pts);
});

EMSCRIPTEN_KEEPALIVE Decoder *decoder_open(int kind) {
    enum AVCodecID id = kind ? AV_CODEC_ID_AAC : AV_CODEC_ID_MPEG2VIDEO;
    Decoder *d = calloc(1, sizeof(*d));
    if (!d) return NULL;
    d->kind = kind;
    d->codec = avcodec_alloc_context3(avcodec_find_decoder(id));
    d->parser = av_parser_init(id);
    d->frame = av_frame_alloc();
    if (!kind) d->filtered_frame = av_frame_alloc();
    if (!d->codec || !d->parser || !d->frame || (!kind && !d->filtered_frame)) goto fail;
    d->codec->pkt_timebase = (AVRational){1, 90000};
    d->codec->thread_count = 1;
    if (avcodec_open2(d->codec, avcodec_find_decoder(id), NULL) < 0) goto fail;
    return d;
fail:
    if (d->parser) av_parser_close(d->parser);
    avcodec_free_context(&d->codec); av_frame_free(&d->frame);
    av_frame_free(&d->filtered_frame); free(d); return NULL;
}

EMSCRIPTEN_KEEPALIVE void decoder_set_playback_pts(Decoder *d, double pts) {
    if (d && !d->kind) d->playback_pts = pts;
}

static int emit_video(Decoder *d, AVFrame *f) {
    if (f->format != AV_PIX_FMT_YUV420P || f->width > 1920 || f->height > 1088) return AVERROR(EINVAL);
    double pts = f->pts == AV_NOPTS_VALUE ? d->next_pts :
        av_rescale_q(f->pts, av_buffersink_get_time_base(d->filter_sink), (AVRational){1, 90000});
    // Do not spend a copy on a frame that the audio clock has already passed.
    if (d->playback_pts > 0 && pts < d->playback_pts - 4500) return 0;
    AVRational sar = f->sample_aspect_ratio;
    int display_width = sar.num && sar.den ? (int)av_rescale(f->width, sar.num, sar.den) : f->width;
    video((int)f->data[0], (int)f->data[1], (int)f->data[2], f->linesize[0], f->linesize[1], f->linesize[2],
        f->width, f->height, display_width, pts, d->input_interlaced,
        f->colorspace, f->color_primaries, f->color_trc);
    return 0;
}

static int drain_video(Decoder *d) {
    int r;
    while ((r = av_buffersink_get_frame(d->filter_sink, d->filtered_frame)) >= 0) {
        int emitted = emit_video(d, d->filtered_frame);
        av_frame_unref(d->filtered_frame);
        if (emitted < 0) return emitted;
    }
    return r == AVERROR(EAGAIN) || r == AVERROR_EOF ? 0 : r;
}

static int flush_video(Decoder *d) {
    if (!d->filter_graph) return 0;
    int r = av_buffersrc_add_frame_flags(d->filter_src, NULL, 0);
    return r < 0 ? r : drain_video(d);
}

static int configure_video(Decoder *d, const AVFrame *f) {
    if (d->filter_graph && d->video_width == f->width && d->video_height == f->height &&
        d->video_format == f->format && !av_cmp_q(d->video_sar, f->sample_aspect_ratio) &&
        d->video_colorspace == f->colorspace && d->video_range == f->color_range) return 0;
    int r = flush_video(d);
    if (r < 0) return r;
    avfilter_graph_free(&d->filter_graph);
    d->filter_src = d->filter_sink = NULL;
    AVFilterGraph *graph = d->filter_graph = avfilter_graph_alloc();
    AVFilterContext *src = NULL, *deinterlace = NULL, *sink = NULL;
    if (!graph) return AVERROR(ENOMEM);
    char args[192];
    snprintf(args, sizeof(args), "video_size=%dx%d:pix_fmt=%d:time_base=1/90000:pixel_aspect=%d/%d:colorspace=%d:range=%d",
        f->width, f->height, f->format, f->sample_aspect_ratio.num, f->sample_aspect_ratio.den,
        f->colorspace, f->color_range);
    r = avfilter_graph_create_filter(&src, avfilter_get_by_name("buffer"), "input", args, NULL, graph);
    if (r >= 0) r = avfilter_graph_create_filter(&deinterlace, avfilter_get_by_name("bwdif"),
        "deinterlace", "mode=send_frame:parity=auto:deint=interlaced", NULL, graph);
    if (r >= 0) r = avfilter_graph_create_filter(&sink, avfilter_get_by_name("buffersink"), "output", NULL, NULL, graph);
    if (r >= 0) r = avfilter_link(src, 0, deinterlace, 0);
    if (r >= 0) r = avfilter_link(deinterlace, 0, sink, 0);
    if (r >= 0) r = avfilter_graph_config(graph, NULL);
    if (r < 0) { avfilter_graph_free(&d->filter_graph); return r; }
    d->filter_src = src;
    d->filter_sink = sink;
    d->video_width = f->width;
    d->video_height = f->height;
    d->video_format = f->format;
    d->video_sar = f->sample_aspect_ratio;
    d->video_colorspace = f->colorspace;
    d->video_range = f->color_range;
    return 0;
}

static int receive(Decoder *d) {
    int r;
    while ((r = avcodec_receive_frame(d->codec, d->frame)) >= 0) {
        AVFrame *f = d->frame;
        double pts = f->best_effort_timestamp == AV_NOPTS_VALUE ? d->next_pts : (double)f->best_effort_timestamp;
        if (!d->kind) {
            if (f->format != AV_PIX_FMT_YUV420P || f->width > 1920 || f->height > 1088) return AVERROR(EINVAL);
            int hd = f->height > 576;
            if (f->colorspace == AVCOL_SPC_UNSPECIFIED)
                f->colorspace = hd ? AVCOL_SPC_BT709 : AVCOL_SPC_SMPTE170M;
            if (f->color_primaries == AVCOL_PRI_UNSPECIFIED)
                f->color_primaries = hd ? AVCOL_PRI_BT709 : AVCOL_PRI_SMPTE170M;
            if (f->color_trc == AVCOL_TRC_UNSPECIFIED)
                f->color_trc = hd ? AVCOL_TRC_BT709 : AVCOL_TRC_SMPTE170M;
            if (f->color_range == AVCOL_RANGE_UNSPECIFIED) f->color_range = AVCOL_RANGE_MPEG;
            d->input_interlaced |= !!(f->flags & AV_FRAME_FLAG_INTERLACED);
            r = configure_video(d, f);
            if (r < 0) return r;
            f->pts = (int64_t)pts;
            r = av_buffersrc_write_frame(d->filter_src, f);
            if (r < 0 || (r = drain_video(d)) < 0) return r;
            AVRational rate = d->codec->framerate;
            d->next_pts = pts + (rate.num ? 90000.0 * rate.den / rate.num : 3003);
        } else {
            // Fixed output format keeps AudioWorklet independent of broadcast sample rate/layout.
            if (d->swr && (d->sample_rate != f->sample_rate || d->sample_format != f->format || av_channel_layout_compare(&d->layout, &f->ch_layout))) {
                swr_free(&d->swr); av_channel_layout_uninit(&d->layout);
            }
            if (!d->swr) {
                AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
                r = swr_alloc_set_opts2(&d->swr, &stereo, AV_SAMPLE_FMT_FLT, 48000,
                    &f->ch_layout, f->format, f->sample_rate, 0, NULL);
                if (r < 0 || (r = swr_init(d->swr)) < 0) return r;
                d->sample_rate = f->sample_rate; d->sample_format = f->format;
                if ((r = av_channel_layout_copy(&d->layout, &f->ch_layout)) < 0) return r;
            }
            if (f->best_effort_timestamp != AV_NOPTS_VALUE)
                pts -= swr_get_delay(d->swr, f->sample_rate) * 90000.0 / f->sample_rate;
            int capacity = swr_get_out_samples(d->swr, f->nb_samples);
            uint8_t *out = av_malloc(capacity * 2 * sizeof(float));
            if (!out) return AVERROR(ENOMEM);
            int count = swr_convert(d->swr, &out, capacity, (const uint8_t**)f->extended_data, f->nb_samples);
            if (count > 0) audio((int)out, count, pts);
            av_free(out);
            if (count < 0) return count;
            d->next_pts = pts + count * 90000.0 / 48000;
        }
        av_frame_unref(f);
    }
    return r == AVERROR(EAGAIN) || r == AVERROR_EOF ? 0 : r;
}

static int packet(Decoder *d, uint8_t *data, int size, int64_t pts, int64_t dts) {
    AVPacket p = {0}; p.data = data; p.size = size; p.pts = pts; p.dts = dts;
    int r = avcodec_send_packet(d->codec, size ? &p : NULL);
    // Live input (and recovery after packet loss) can begin before a sequence
    // header. Discard only malformed packets and keep parsing until the next
    // decodable picture; allocation/format errors must still reach the caller.
    if (r == AVERROR_INVALIDDATA) return 0;
    if (r < 0) return r;
    r = receive(d);
    return r == AVERROR_INVALIDDATA ? 0 : r;
}

EMSCRIPTEN_KEEPALIVE int decoder_push(Decoder *d, uint8_t *input, int size, double pts, double dts) {
    // The AAC parser may discard the first packet timestamp while acquiring ADTS sync.
    // Seed the sample clock from PES instead of emitting initial PCM at timestamp zero.
    if (!d->timestamp_initialized && pts >= 0) {
        d->next_pts = pts;
        d->timestamp_initialized = 1;
    }
    uint8_t *data = av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!data) return AVERROR(ENOMEM);
    memcpy(data, input, size);
    uint8_t *cursor = data;
    int result = 0;
    while (size > 0) {
        uint8_t *out; int length;
        int used = av_parser_parse2(d->parser, d->codec, &out, &length, cursor, size,
            pts < 0 ? AV_NOPTS_VALUE : (int64_t)pts, dts < 0 ? AV_NOPTS_VALUE : (int64_t)dts, -1);
        if (used < 0) { result = used; break; }
        if (length && (result = packet(d, out, length, d->parser->pts, d->parser->dts)) < 0) break;
        if (!used && !length) break;
        cursor += used; size -= used; pts = dts = -1;
    }
    av_free(data); return result;
}
EMSCRIPTEN_KEEPALIVE int decoder_flush(Decoder *d) {
    uint8_t *out; int length;
    av_parser_parse2(d->parser, d->codec, &out, &length, NULL, 0, AV_NOPTS_VALUE, AV_NOPTS_VALUE, -1);
    int r = length ? packet(d, out, length, d->parser->pts, d->parser->dts) : 0;
    if (r >= 0) r = packet(d, NULL, 0, AV_NOPTS_VALUE, AV_NOPTS_VALUE);
    if (r >= 0 && !d->kind) r = flush_video(d);
    if (r >= 0 && d->swr) {
        float tail[4096]; uint8_t *out = (uint8_t*)tail;
        int count;
        while ((count = swr_convert(d->swr, &out, 2048, NULL, 0)) > 0) {
            audio((int)out, count, d->next_pts); d->next_pts += count * 90000.0 / 48000;
        }
        if (count < 0) r = count;
    }
    return r;
}
EMSCRIPTEN_KEEPALIVE void decoder_close(Decoder *d) {
    if (!d) return;
    swr_free(&d->swr); av_channel_layout_uninit(&d->layout);
    avfilter_graph_free(&d->filter_graph); av_frame_free(&d->filtered_frame);
    av_parser_close(d->parser); avcodec_free_context(&d->codec); av_frame_free(&d->frame); free(d);
}
EMSCRIPTEN_KEEPALIVE void *media_alloc(int n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void media_free(void *p) { free(p); }
