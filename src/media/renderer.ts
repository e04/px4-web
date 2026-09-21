import type { VideoPicture } from './playback-types';

/** Planar 4:2:0 upload with limited-range BT.709 (HD) / BT.601 (SD). */
export class YuvRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private textures: WebGLTexture[] = [];
  private buffer: WebGLBuffer;
  private uHd: WebGLUniformLocation | null = null;
  constructor(private canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer lets the ambient glow copy the frame via drawImage.
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL is required for MPEG-2 rendering');
    this.gl = gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? 'Shader error');
      return s;
    };
    const vertex = shader(
      gl.VERTEX_SHADER,
      'attribute vec2 p; varying vec2 uv; void main(){gl_Position=vec4(p,0.,1.);uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);}',
    );
    const fragment = shader(
      gl.FRAGMENT_SHADER,
      `precision highp float;
      varying vec2 uv; uniform sampler2D y, u, v;
      uniform float hd;
      vec3 fetch(vec2 p){ return vec3(texture2D(y,p).r,texture2D(u,p).r,texture2D(v,p).r); }
      void main(){
        vec3 c=fetch(uv);
        c-=vec3(16./255.,128./255.,128./255.); c.r*=1.164383;
        vec3 sd=vec3(c.r+1.596027*c.b,c.r-.391762*c.g-.812968*c.b,c.r+2.017232*c.g);
        vec3 high=vec3(c.r+1.792741*c.b,c.r-.213249*c.g-.532909*c.b,c.r+2.112402*c.g);
        gl_FragColor=vec4(mix(sd,high,hd),1.); }`,
    );
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error('YUV shader link failed');
    gl.useProgram(this.program);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.program, 'p');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    for (let i = 0; i < 3; i++) {
      const texture = gl.createTexture()!;
      this.textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(this.program, ['y', 'u', 'v'][i]), i);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.uHd = gl.getUniformLocation(this.program, 'hd');
  }
  draw(frame: VideoPicture): void {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('WebGL context lost; restart playback');
    const videoW = Math.round(frame.height * frame.aspect);
    const videoH = frame.height;
    // Keep the GPU target near the display size without rendering full 4K frames.
    const dpr =
      typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    const fit =
      cssW > 0 && cssH > 0 ? Math.min(cssW / videoW, cssH / videoH) : 1 / dpr;
    const scale = Number.isFinite(fit) ? Math.min(1.5, Math.max(0.25, fit * dpr)) : 1;
    const targetW = Math.round(videoW * scale);
    const targetH = Math.round(videoH * scale);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    gl.viewport(0, 0, targetW, targetH);
    gl.useProgram(this.program);
    let offset = 0;
    for (let i = 0; i < 3; i++) {
      const w = i ? Math.ceil(frame.width / 2) : frame.width,
        h = i ? Math.ceil(frame.height / 2) : frame.height;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        w,
        h,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        frame.bytes.subarray(offset, offset + w * h),
      );
      offset += w * h;
    }
    gl.uniform1f(this.uHd, frame.height > 576 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  close(): void {
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
  }
}
