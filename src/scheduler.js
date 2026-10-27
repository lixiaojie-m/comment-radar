import { runPipeline } from './pipeline.js';
import { getConfig } from './config.js';

let timer = null;

// 用 setTimeout 链而非 setInterval，间隔每次从配置现读，设置页改完即时生效
function schedule() {
  const cfg = getConfig();
  const minutes = Math.max(5, Number(cfg.fetchIntervalMinutes) || 1440);
  timer = setTimeout(async () => {
    if (!getConfig().paused) {
      try {
        await runPipeline('schedule');
      } catch (e) {
        console.error('[scheduler]', e);
      }
    }
    schedule();
  }, minutes * 60_000);
}

export function startScheduler() {
  setTimeout(async () => {
    if (getConfig().paused) {
      console.log('[scheduler] 已暂停，跳过启动抓取');
      schedule();
      return;
    }
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
