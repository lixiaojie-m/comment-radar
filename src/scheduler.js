import { runPipeline } from './pipeline.js';
import { getConfig } from './config.js';

let timer = null;

// 用 setTimeout 链而非 setInterval，间隔每次从配置现读，设置页改完即时生效
function schedule() {
  const minutes = Math.max(5, Number(getConfig().fetchIntervalMinutes) || 30);
  timer = setTimeout(async () => {
    try {
      await runPipeline('schedule');
    } catch (e) {
      console.error('[scheduler]', e);
    }
    schedule();
  }, minutes * 60_000);
}

export function startScheduler() {
  setTimeout(async () => {
    try {
      await runPipeline('boot');
    } catch (e) {
      console.error('[scheduler-boot]', e);
    }
    schedule();
  }, 3_000);
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
}
