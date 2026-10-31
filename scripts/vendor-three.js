'use strict';
// Copies three.js (MIT) and the few post-processing files the Warlock
// window uses into src/renderer/vendor/three, rewriting the bare 'three'
// import to a relative path (the window's CSP allows only local scripts).
// Run after changing the three version:  node scripts/vendor-three.js
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'three');
const out = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'three');
const files = [
  'postprocessing/EffectComposer.js', 'postprocessing/RenderPass.js', 'postprocessing/UnrealBloomPass.js',
  'postprocessing/OutputPass.js', 'postprocessing/ShaderPass.js', 'postprocessing/MaskPass.js', 'postprocessing/Pass.js',
  'shaders/CopyShader.js', 'shaders/LuminosityHighPassShader.js', 'shaders/OutputShader.js',
  'loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js',
];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'postprocessing'), { recursive: true });
fs.mkdirSync(path.join(out, 'shaders'), { recursive: true });
fs.mkdirSync(path.join(out, 'loaders'), { recursive: true });
fs.mkdirSync(path.join(out, 'utils'), { recursive: true });
fs.copyFileSync(path.join(src, 'build', 'three.module.min.js'), path.join(out, 'three.module.min.js'));
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'));
for (const f of files) {
  const code = fs.readFileSync(path.join(src, 'examples', 'jsm', f), 'utf8').replace(/from 'three';/g, "from '../three.module.min.js';");
  fs.writeFileSync(path.join(out, f), code);
}
console.log('three.js', require(path.join(src, 'package.json')).version, '→', out);
