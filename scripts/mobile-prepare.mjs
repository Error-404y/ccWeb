import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const target = process.argv[2];
if (!['ios', 'android'].includes(target)) throw new Error('Choose ios or android.');
const api = new URL(process.env.QZU_APP_ORIGIN || 'https://qzu.cc');
if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) throw new Error('Use a valid HTTPS server origin.');
const run = (program, args) => execFileSync(program, args, { stdio: 'inherit' });
const cap = (...args) => run('npx', ['cap', ...args]);

rmSync('mobile-dist', { recursive: true, force: true });
cpSync('public', 'mobile-dist', { recursive: true });
mkdirSync('mobile-dist/vendor', { recursive: true });
cpSync('node_modules/jsqr/dist/jsQR.js', 'mobile-dist/vendor/jsqr.js');
writeFileSync('mobile-dist/mobile-config.js', 'window.QZU_API_ORIGIN = ' + JSON.stringify(api.origin) + ';\n');
let html = readFileSync('mobile-dist/index.html', 'utf8');
html = html.replace('<script src="/app.js" defer></script>', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\' ' + api.origin + '; media-src \'self\' blob: data:; object-src \'none\'; base-uri \'none\'"><script src="/mobile-config.js" defer></script><script src="/app.js" defer></script>');
writeFileSync('mobile-dist/index.html', html);
if (!existsSync(target)) cap('add', target);

if (target === 'ios') {
  const app = 'ios/App/App';
  const delegate = app + '/AppDelegate.swift';
  const nativeCode = readFileSync('mobile/ios/QzuDevice.swift', 'utf8');
  const marker = '\n// QZU_NATIVE_DEVICE\n';
  const original = readFileSync(delegate, 'utf8').split(marker)[0];
  writeFileSync(delegate, original + marker + nativeCode);
  const scene = app + '/Base.lproj/Main.storyboard';
  let storyboard = readFileSync(scene, 'utf8');
  if (!storyboard.includes('customClass="QzuViewController"')) {
    if (!storyboard.includes('customClass="CAPBridgeViewController"')) throw new Error('Unexpected iOS template. Register QzuViewController manually.');
    storyboard = storyboard.replace(/customClass="CAPBridgeViewController"(?: customModule="[^"]+")?(?: customModuleProvider="[^"]+")?/, 'customClass="QzuViewController" customModule="App" customModuleProvider="target"');
    writeFileSync(scene, storyboard);
  }
  const plist = app + '/Info.plist';
  for (const [key, value] of [['NSCameraUsageDescription', 'Scan qzu. connection codes.'], ['NSMicrophoneUsageDescription', 'Record voice messages.']]) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :' + key + ' ' + value, plist], { stdio: 'ignore' }); }
    catch { run('/usr/libexec/PlistBuddy', ['-c', 'Add :' + key + ' string ' + value, plist]); }
  }
} else {
  const java = 'android/app/src/main/java/cc/qzu/app';
  cpSync('mobile/android/QzuDevice.java', java + '/QzuDevice.java');
  cpSync('mobile/android/MainActivity.java', java + '/MainActivity.java');
  const manifest = 'android/app/src/main/AndroidManifest.xml';
  let xml = readFileSync(manifest, 'utf8');
  for (const permission of ['CAMERA', 'RECORD_AUDIO']) {
    if (!xml.includes('android.permission.' + permission)) xml = xml.replace('</manifest>', '<uses-permission android:name="android.permission.' + permission + '" />\n</manifest>');
  }
  xml = xml.replace('android:allowBackup="true"', 'android:allowBackup="false"');
  writeFileSync(manifest, xml);
}
cap('sync', target);
