import { spawn } from 'child_process';

const appPath = 'C:\\Users\\kunal\\OneDrive\\Desktop\\swarm\\spike\\desktop-shell\\src-tauri\\target\\debug\\app.exe';
const proc = spawn(appPath, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
  },
  detached: false,
});

console.log('Spawned app.exe PID:', proc.pid);

setTimeout(async () => {
  try {
    const res = await fetch('http://127.0.0.1:9222/json');
    const data = await res.json();
    console.log('CDP targets:', data);
  } catch (err) {
    console.error('CDP fetch error:', err);
  } finally {
    proc.kill();
  }
}, 4000);
