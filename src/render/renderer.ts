import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { QualityProfile } from '../core/settings';
import type { PlanarReflection } from './reflection';

// 后处理链：场景 → 泛光（让灯和枪口焰"发光"）→ 调色与暗角 → 色调映射输出。
// 整条链都在线性 HDR 空间里算，最后一步才压回屏幕能显示的范围。

const GRADE = {
  uniforms: { tDiffuse: { value: null }, uHurt: { value: 0 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uHurt; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(1.0, 0.3, smoothstep(0.3, 0.9, d));                 // 暗角
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, 1.1 - uHurt * 0.6);                  // 受伤时画面褪色
      c.rgb += vec3(0.0, 0.003, 0.008) * (1.0 - smoothstep(0.0, 0.25, l)); // 暗部带一点冷色
      gl_FragColor = c;
    }`,
};

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private grade!: ShaderPass;
  private profile!: QualityProfile;
  reflection: PlanarReflection | null = null;

  constructor(private canvas: HTMLCanvasElement, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  setQuality(p: QualityProfile, sun: THREE.DirectionalLight) {
    this.profile = p;
    sun.castShadow = p.shadow > 0;
    if (p.shadow > 0 && sun.shadow.mapSize.x !== p.shadow) {
      sun.shadow.mapSize.set(p.shadow, p.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    this.composer?.dispose();
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.gl.setPixelRatio(p.pixelRatio);
    this.gl.setSize(w, h, false);
    const target = new THREE.WebGLRenderTarget(w * p.pixelRatio, h * p.pixelRatio, { type: THREE.HalfFloatType, samples: p.shadow >= 2048 ? 4 : p.shadow > 0 ? 2 : 0 });
    this.composer = new EffectComposer(this.gl, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (p.bloom) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.55, 1.0));
    this.grade = new ShaderPass(GRADE);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.gl.setPixelRatio(this.profile.pixelRatio);
    this.gl.setSize(w, h, false);
    this.composer.setPixelRatio(this.profile.pixelRatio);
    this.composer.setSize(w, h);
    this.reflection?.configure(this.profile.reflect, w * this.profile.pixelRatio, h * this.profile.pixelRatio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(hurt: number, time = 0) {
    this.reflection?.render(time);
    this.grade.uniforms.uHurt.value = hurt;
    this.composer.render();
  }
}
