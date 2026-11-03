'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const environment = require('../js/environment.js');
const ROOT = path.resolve(__dirname, '..');
const script = 'https://example.test/guandan/js/environment.js?v=1';
function surface({ ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', touch = 0, mobile, coarse = false,
  width = 1366, height = 768, secure = true, protocol = 'https:', installed = false, worker = true } = {}) {
  return { navigator: { userAgent:ua, maxTouchPoints:touch, ...(mobile===undefined?{}:{userAgentData:{mobile}}),
    ...(worker?{serviceWorker:{}}:{}) }, screen:{width,height}, isSecureContext:secure, location:{protocol},
    matchMedia: query=>({matches:query==='(display-mode: standalone)'?installed:coarse}) };
}
for (const scenario of [
  { name:'Android phone client hint', data:{ua:'Chromium',mobile:true}, expected:'mobile' },
  { name:'iPhone Safari in landscape', data:{ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari',touch:5,width:844,height:390},expected:'mobile' },
  { name:'Android tablet without mobile client hint',data:{ua:'Mozilla/5.0 (Linux; Android 15; Tablet) Chrome Safari',mobile:false,touch:5},expected:'mobile' },
  { name:'iPad using a desktop Safari user agent',data:{ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Safari',touch:5},expected:'mobile' },
  { name:'Mac computer',data:{ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari'},expected:'desktop' },
  { name:'Windows computer in a narrow window',data:{width:390,height:844},expected:'desktop' },
  { name:'Windows touchscreen laptop',data:{touch:10,coarse:true,width:1280,height:800},expected:'desktop' },
  { name:'unknown touch browser on a phone',data:{ua:'Custom Browser',touch:5,coarse:true,width:390,height:844},expected:'mobile' },
  { name:'unknown browser without device hints',data:{ua:'Custom Browser'},expected:'desktop' }
]) test(scenario.name,()=>assert.equal(environment.inspect(surface(scenario.data)).device,scenario.expected));

test('phone root URL preserves the project path, invitation and fragment',()=>{
  const current='https://example.test/guandan/?online=public&room=123456&server=https%3A%2F%2Frooms.test#table';
  const destination=new URL(environment.redirect(current,script,'desktop',{device:'mobile'}));
  assert.equal(destination.pathname,'/guandan/mobile/index.html');
  assert.equal(destination.searchParams.get('room'),'123456');
  assert.equal(destination.searchParams.get('server'),'https://rooms.test');
  assert.equal(destination.hash,'#table');
  assert.equal(destination.searchParams.has('view'),false);
  assert.equal(environment.redirect(destination.href,script,'mobile',{device:'mobile'}),null);
});
test('manual desktop selection on a phone stays on desktop',()=>{
  const url=environment.viewURL('https://example.test/guandan/mobile/?online=public&room=123456',script,'desktop');
  assert.equal(new URL(url).searchParams.get('view'),'desktop');
  assert.equal(new URL(url).searchParams.get('room'),'123456');
  assert.equal(environment.redirect(url,script,'desktop',{device:'mobile'}),null);
});
test('explicit mobile links and installed apps keep their selected entry',()=>{
  assert.equal(environment.redirect('https://example.test/guandan/mobile/',script,'mobile',{device:'desktop'}),null);
  assert.equal(environment.redirect('https://example.test/guandan/',script,'desktop',{device:'mobile',installed:true}),null);
  const url='https://example.test/guandan/?view=mobile';
  assert.equal(new URL(environment.redirect(url,script,'desktop',{device:'desktop'})).pathname,'/guandan/mobile/index.html');
});
test('local file routing works without a server and invalid choices cannot redirect externally',()=>{
  const url=environment.redirect('file:///Games/guandan/index.html?online=public','file:///Games/guandan/js/environment.js','desktop',{device:'mobile'});
  assert.equal(url,'file:///Games/guandan/mobile/index.html?online=public');
  assert.equal(environment.viewURL('https://example.test/',script,'https://attacker.test'),null);
  assert.equal(environment.redirect('https://example.test/guandan/?view=https://attacker.test',script,'desktop',{device:'desktop'}),null);
});
test('device selection does not depend on HTTPS or HTTP',()=>{
  const phone={ua:'iPhone Mobile',touch:5};
  assert.equal(environment.inspect(surface({...phone,secure:false,protocol:'http:'})).device,'mobile');
  assert.equal(environment.inspect(surface({...phone,secure:true})).device,'mobile');
  assert.equal(environment.inspect(surface({secure:false,protocol:'http:'})).device,'desktop');
});
test('entry script runs before styles, routes once, and updates real manual links',()=>{
  const source=fs.readFileSync(path.join(ROOT,'js/environment.js'),'utf8');
  for (const entry of ['desktop','mobile']) {
    const html=fs.readFileSync(path.join(ROOT,entry==='mobile'?'mobile/index.html':'index.html'),'utf8');
    assert(html.indexOf('js/environment.js')>=0 && html.indexOf('js/environment.js')<html.indexOf('rel="stylesheet"'));
    const {document,window}=parseHTML(html);
    const currentScript=document.querySelector('script[data-entry]');
    Object.defineProperty(currentScript,'src',{value:script});
    Object.defineProperty(document,'currentScript',{value:currentScript});
    const redirects=[];
    const current=`https://example.test/guandan/${entry==='mobile'?'mobile/':''}?online=public&room=123456`;
    const root={...surface(),document,location:Object.assign(new URL(current),{replace:url=>redirects.push(url)})};
    vm.runInNewContext(source,{window:root,URL});
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    assert.equal(redirects.length,0);
    const link=document.querySelector('[data-game-view]'), next=new URL(link.href);
    assert.equal(next.searchParams.get('room'),'123456');
    assert.equal(next.searchParams.get('view'),entry==='mobile'?'desktop':'mobile');
  }
});
