import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { iconPng } from './app-icon.mjs';
import { playAssets } from './play-assets.mjs';

const target = process.argv[2];
if (!['ios', 'android'].includes(target)) throw new Error('Choose ios or android.');
const distribution=target==='android'&&process.env.QZU_DISTRIBUTION==='google-play'?'google-play':'direct';
const release = JSON.parse(readFileSync('package.json', 'utf8')).version;
const versionParts = release.split('.').map(Number);
if (!/^\d+\.\d+\.\d+$/.test(release) || versionParts.some(n => n > 999)) throw Error('Use a numeric release version with components below 1000.');
const buildNumber = 1 + versionParts[0] * 1000000 + versionParts[1] * 1000 + versionParts[2];
const api = new URL(process.env.QZU_APP_ORIGIN || 'https://qzu.duckdns.org');
if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) throw new Error('Use a valid HTTPS server origin.');
const run = (program, args) => execFileSync(program, args, { stdio: 'inherit' });
const cap = (...args) => run('npx', ['cap', ...args]);
function installIcons() {
  if (target === 'ios') {
    const folder = 'ios/App/App/Assets.xcassets/AppIcon.appiconset';
    mkdirSync(folder, { recursive: true });
    iconPng(folder + '/qzu-icon.png', 1024);
    writeFileSync(folder + '/Contents.json', JSON.stringify({
      images: [{ filename: 'qzu-icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
      info: { author: 'xcode', version: 1 }
    }, null, 2) + '\n');
    return;
  }
  const res = 'android/app/src/main/res';
  for (const [density, legacy, adaptive] of [['mdpi',48,108],['hdpi',72,162],['xhdpi',96,216],['xxhdpi',144,324],['xxxhdpi',192,432]]) {
    const folder = res + '/mipmap-' + density;
    mkdirSync(folder, { recursive: true });
    for (const name of ['ic_launcher','ic_launcher_round']) {
      rmSync(folder + '/' + name + '.webp', { force: true });
      iconPng(folder + '/' + name + '.png', legacy);
    }
    iconPng(folder + '/qzu_icon_foreground.png', adaptive, true);
  }
  const adaptive = res + '/mipmap-anydpi-v26';
  mkdirSync(adaptive, { recursive: true });
  for (const name of ['ic_launcher','ic_launcher_round']) {
    writeFileSync(adaptive + '/' + name + '.xml', '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@android:color/black"/><foreground android:drawable="@mipmap/qzu_icon_foreground"/></adaptive-icon>\n');
  }
}

rmSync('mobile-dist', { recursive: true, force: true });
cpSync('public', 'mobile-dist', { recursive: true });
for(const legal of ['privacy.html','privacy.css','terms.html','delete-account.html'])rmSync('mobile-dist/'+legal,{force:true});
if(distribution==='google-play')writeFileSync('mobile-dist/app.js',playAssets(readFileSync('mobile-dist/app.js','utf8')));
mkdirSync('mobile-dist/vendor', { recursive: true });
cpSync('node_modules/jsqr/dist/jsQR.js', 'mobile-dist/vendor/jsqr.js');
cpSync('node_modules/@capacitor/core/dist/capacitor.js', 'mobile-dist/vendor/capacitor.js');
writeFileSync('mobile-dist/mobile-config.js', 'window.QZU_API_ORIGIN = ' + JSON.stringify(api.origin) + ';\nwindow.QZU_APP_VERSION = ' + JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) + ';\nwindow.QZU_DISTRIBUTION = ' + JSON.stringify(distribution) + ';\n');
let html = readFileSync('mobile-dist/index.html', 'utf8');
html = html.replace('width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content', 'width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content');
html = html.replace('<script src="/app.js" defer></script>', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\' ' + api.origin + '; media-src \'self\' blob: data:; object-src \'none\'; base-uri \'none\'"><script src="/vendor/capacitor.js" defer></script><script src="/mobile-config.js" defer></script><script src="/app.js" defer></script>');
writeFileSync('mobile-dist/index.html', html);
if (!existsSync(target)) cap('add', target);

if (target === 'ios') {
  const app = 'ios/App/App';
  const delegate = app + '/AppDelegate.swift';
  const nativeCode = readFileSync('mobile/ios/QzuDevice.swift', 'utf8');
  const marker = '\n// QZU_NATIVE_DEVICE\n';
  let original = readFileSync(delegate, 'utf8').split(marker)[0];
  const pushCallbacks=[];
  if(!original.includes('didRegisterForRemoteNotificationsWithDeviceToken'))pushCallbacks.push('    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken) }');
  if(!original.includes('didFailToRegisterForRemoteNotificationsWithError'))pushCallbacks.push('    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error) }');
  if(pushCallbacks.length){const end=original.lastIndexOf('}');if(end<0)throw Error('Unexpected AppDelegate. Configure push callbacks manually.');original=original.slice(0,end)+pushCallbacks.join('\n')+'\n'+original.slice(end);}
  writeFileSync(delegate, original + marker + nativeCode);
  const scene = app + '/Base.lproj/Main.storyboard';
  let storyboard = readFileSync(scene, 'utf8');
  if (!storyboard.includes('customClass="QzuViewController"')) {
    if (!storyboard.includes('customClass="CAPBridgeViewController"')) throw new Error('Unexpected iOS template. Register QzuViewController manually.');
    storyboard = storyboard.replace(/customClass="CAPBridgeViewController"(?: customModule="[^"]+")?(?: customModuleProvider="[^"]+")?/, 'customClass="QzuViewController" customModule="App" customModuleProvider="target"');
    writeFileSync(scene, storyboard);
  }
  const project = 'ios/App/App.xcodeproj/project.pbxproj';
  let settings = readFileSync(project, 'utf8');
  if (!/MARKETING_VERSION\s*=/.test(settings) || !/CURRENT_PROJECT_VERSION\s*=/.test(settings)) throw Error('Unexpected Xcode version settings.');
  settings = settings.replace(/MARKETING_VERSION\s*=\s*[^;]+;/g, 'MARKETING_VERSION = ' + release + ';').replace(/CURRENT_PROJECT_VERSION\s*=\s*[^;]+;/g, 'CURRENT_PROJECT_VERSION = ' + buildNumber + ';');
  writeFileSync(project, settings);
  const plist = app + '/Info.plist';
  for (const [key, value] of [['NSCameraUsageDescription', 'Scan qzu. connection codes.'], ['NSMicrophoneUsageDescription', 'Record voice messages.']]) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :' + key + ' ' + value, plist], { stdio: 'ignore' }); }
    catch { run('/usr/libexec/PlistBuddy', ['-c', 'Add :' + key + ' string ' + value, plist]); }
  }
} else {
  const gradle = 'android/app/build.gradle';
  let settings = readFileSync(gradle, 'utf8');
  if (!/\bversionCode\s+\d+/.test(settings) || !/\bversionName\s+["'][^"']+["']/.test(settings)) throw Error('Unexpected Android version settings.');
  settings = settings.replace(/\bversionCode\s+\d+/, 'versionCode ' + buildNumber).replace(/\bversionName\s+["'][^"']+["']/, 'versionName "' + release + '"');
  writeFileSync(gradle, settings);
  const java = 'android/app/src/main/java/cc/qzu/app';
  cpSync('mobile/android/QzuDevice.java', java + '/QzuDevice.java');
  cpSync('mobile/android/MainActivity.java', java + '/MainActivity.java');
  const manifest = 'android/app/src/main/AndroidManifest.xml';
  let xml = readFileSync(manifest, 'utf8');
  for (const permission of ['CAMERA', 'RECORD_AUDIO', 'POST_NOTIFICATIONS']) {
    if (!xml.includes('android.permission.' + permission)) xml = xml.replace('</manifest>', '<uses-permission android:name="android.permission.' + permission + '" />\n</manifest>');
  }
  xml = xml.replace('android:allowBackup="true"', 'android:allowBackup="false"');
  writeFileSync(manifest, xml);
}
cap('sync', target);
installIcons();
if (target === 'ios') {
  const configPath = 'ios/App/App/capacitor.config.json';
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.packageClassList = [...new Set([...(config.packageClassList || []), 'QzuDevice'])];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('Registered iOS QzuDevice in native plugin configuration.');
}
