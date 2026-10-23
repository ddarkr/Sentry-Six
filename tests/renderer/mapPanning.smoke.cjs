// Run: node_modules/.bin/electron tests/renderer/mapPanning.smoke.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-map-pan-'));
app.setPath('userData', path.join(temp, 'profile'));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
    let exitCode = 0;
    try {
        const url = file => pathToFileURL(path.join(root, file)).href;
        const html = path.join(temp, 'map.html');
        fs.writeFileSync(html, `<!doctype html><base href="${url('src/renderer/')}"><link rel="stylesheet" href="${url('src/renderer/vendor/leaflet/leaflet.css')}">
            <style>#mapVis{position:absolute;left:100px;top:100px;width:500px;height:400px;overflow:hidden}#map{width:100%;height:100%}</style>
            <div id="mapVis"><div id="map"></div></div><script src="${url('src/renderer/vendor/leaflet/leaflet.js')}"></script>`);
        await win.loadFile(html);
        const source = fs.readFileSync(path.join(root, 'src/renderer/script.js'), 'utf8');
        // Exercise the production event handlers with real Leaflet and browser transforms.
        const handlers = source.slice(source.indexOf('// Enable right-click drag'), source.indexOf('// Helper to re-center map'));
        const result = await win.webContents.executeJavaScript(`(async () => {
            const map = L.map('map', {dragging:false, zoomControl:false, attributionControl:false}).setView([37.5,127],16);
            L.polyline([[37.498,126.998],[37.5,127],[37.502,127.002]]).addTo(map);
            const module = await import(${JSON.stringify(url('src/renderer/scripts/ui/mapVisualization.js'))});
            module.initMapVisualization({getMap:()=>map, getState:()=>({})});
            ${handlers}
            const settle = () => new Promise(resolve => setTimeout(resolve, 350));
            const position = () => {
                const rect = document.querySelector('.arrow-marker-icon').getBoundingClientRect();
                return {x:rect.x+rect.width/2, y:rect.y+rect.height/2};
            };
            const mouse = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, {
                bubbles:true, button:2, buttons:type==='mouseup'?0:2, clientX:x, clientY:y
            }));
            const results = [];
            async function drag(label) {
                const before = position();
                mouse(mapEl, 'mousedown', 300, 250);
                // Multiple moves catch accumulation/overshoot, not just the first delta.
                mouse(document, 'mousemove', 320, 260);
                mouse(document, 'mousemove', 360, 280);
                mouse(document, 'mouseup', 360, 280);
                const after = position();
                const delta = {x:after.x-before.x, y:after.y-before.y};
                if (Math.abs(delta.x-60)>2 || Math.abs(delta.y-30)>2) {
                    throw new Error(label+': expected (60,30), got '+JSON.stringify(delta));
                }
                mouse(document, 'mousemove', 390, 300);
                const released = position();
                if (released.x!==after.x || released.y!==after.y) throw new Error('Drag continued after release');
                results.push({label, delta});
            }
            for (const mode of ['heading-up','north-up']) {
                for (const heading of [0,45,90,180,270]) {
                    module.setMapOrientation(mode);
                    module.updateMapMarker({latitudeDeg:37.5,longitudeDeg:127,headingDeg:heading},()=>true);
                    await settle();
                    await drag(mode+' '+heading);
                }
            }
            module.setMapOrientation('heading-up');
            await new Promise(resolve=>setTimeout(resolve,100));
            await drag('orientation transition');
            return results;
        })()`);
        console.log(JSON.stringify(result, null, 2));
        if (process.env.MAP_PAN_SCREENSHOT) {
            fs.writeFileSync(process.env.MAP_PAN_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
        }
    } catch (error) {
        console.error(error);
        exitCode = 1;
    } finally {
        win.destroy();
        fs.rmSync(temp, { recursive: true, force: true });
    }
    app.exit(exitCode);
});
