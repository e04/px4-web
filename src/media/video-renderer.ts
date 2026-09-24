/** Draws a decoded frame into its canvas's backing store at the given size. */
export interface VideoRenderer {
  draw(frame: VideoFrame, width: number, height: number): void;
  dispose(): void;
}

/** Lanczos-3 widened by the shrink factor up to this, bounding a pass to 25 taps. */
const MAX_STRETCH = 4;

const VERTEX = `#version 300 es
void main() {
  // One oversized triangle covers the viewport without a vertex buffer.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Separable Lanczos-3 along one axis. The other axis maps 1:1 between input and output.
// When shrinking, the kernel stretches by the scale so it also low-passes (no aliasing).
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform bool vertical;
uniform float outputSize;
out vec4 color;
const float PI = 3.14159265358979;
float lanczos(float x) {
  if (x == 0.0) return 1.0;
  if (abs(x) >= 3.0) return 0.0;
  float px = PI * x;
  return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}
void main() {
  ivec2 size = textureSize(source, 0);
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  // Anamorphic 1440x1080 uploads at its coded width, so derive the ratio from the texture.
  float scale = float(vertical ? size.y : size.x) / outputSize;
  float stretch = min(max(scale, 1.0), ${MAX_STRETCH.toFixed(1)});
  float center = (vertical ? gl_FragCoord.y : gl_FragCoord.x) * scale - 0.5;
  int first = int(floor(center - 3.0 * stretch)) + 1;
  int last = int(floor(center + 3.0 * stretch));
  int limit = (vertical ? size.y : size.x) - 1;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = first; i <= last; i++) {
    float w = lanczos((float(i) - center) / stretch);
    int j = clamp(i, 0, limit);
    sum += w * texelFetch(source, vertical ? ivec2(pixel.x, j) : ivec2(j, pixel.y), 0);
    total += w;
  }
  color = clamp(sum / total, 0.0, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost())
    throw new Error(`Lanczos shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

interface Resources {
  program: WebGLProgram;
  vertical: WebGLUniformLocation | null;
  outputSize: WebGLUniformLocation | null;
  source: WebGLTexture;
  intermediate: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

/** Two-pass (horizontal then vertical) Lanczos-3 in WebGL2; the browser converts YUV→RGB on upload. */
class LanczosRenderer implements VideoRenderer {
  private resources?: Resources;
  /** Intermediate precision: half float keeps the negative lobes between passes when available. */
  private halfFloat: boolean;

  constructor(
    private canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
  ) {
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    canvas.addEventListener('webglcontextlost', this.onLost);
  }

  private onLost = (event: Event) => {
    event.preventDefault();
    // Handles die with the context; rebuild lazily once it is restored.
    this.resources = undefined;
  };

  private texture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private setup(): Resources {
    const gl = this.gl;
    const program = gl.createProgram()!;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
      throw new Error(`Lanczos program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'source'), 0);
    // GL rows run bottom-up; flipping on upload keeps both passes in one orientation.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    return {
      program,
      vertical: gl.getUniformLocation(program, 'vertical'),
      outputSize: gl.getUniformLocation(program, 'outputSize'),
      source: this.texture(),
      intermediate: this.texture(),
      framebuffer: gl.createFramebuffer()!,
      width: 0,
      height: 0,
    };
  }

  draw(frame: VideoFrame, width: number, height: number): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const r = (this.resources ??= this.setup());
    gl.useProgram(r.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.source);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    // Horizontal pass: source columns → output width, source rows kept.
    const rows = frame.displayHeight;
    gl.bindTexture(gl.TEXTURE_2D, r.intermediate);
    if (r.width !== width || r.height !== rows) {
      r.width = width;
      r.height = rows;
      if (this.halfFloat)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, rows, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        r.intermediate,
        0,
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, r.source);
    gl.viewport(0, 0, width, rows);
    gl.uniform1i(r.vertical, 0);
    gl.uniform1f(r.outputSize, width);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Vertical pass: intermediate rows → output height, into the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, r.intermediate);
    gl.viewport(0, 0, width, height);
    gl.uniform1i(r.vertical, 1);
    gl.uniform1f(r.outputSize, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    const r = this.resources;
    this.resources = undefined;
    if (!r || this.gl.isContextLost()) return;
    // The canvas outlives the player (it is reused by the next one), so free GPU objects now.
    this.gl.deleteProgram(r.program);
    this.gl.deleteTexture(r.source);
    this.gl.deleteTexture(r.intermediate);
    this.gl.deleteFramebuffer(r.framebuffer);
  }
}

/** Fallback without WebGL2: Canvas 2D's own filter. */
class Canvas2DRenderer implements VideoRenderer {
  constructor(private surface: CanvasRenderingContext2D) {}
  draw(frame: VideoFrame, width: number, height: number): void {
    // Resizing the canvas resets context state, so set quality on every draw.
    this.surface.imageSmoothingQuality = 'high';
    this.surface.drawImage(frame, 0, 0, width, height);
  }
  dispose(): void {}
}

export function createVideoRenderer(canvas: HTMLCanvasElement): VideoRenderer {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // The ambient backdrop copies this canvas from its own animation frame.
    preserveDrawingBuffer: true,
  });
  if (gl) return new LanczosRenderer(canvas, gl);
  const surface = canvas.getContext('2d', { alpha: false });
  if (!surface) throw new Error('WebGL2 or Canvas 2D is required for video output');
  return new Canvas2DRenderer(surface);
}
