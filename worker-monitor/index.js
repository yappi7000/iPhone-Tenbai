/*
 * 価格鮮度の監視専用 Worker（iphone-tenbai-monitor）
 *
 * 既存の今すぐ更新の Worker（worker/、iphone-tenbai-refresh）とは別に動かし、
 * HTTP の受付・その秘密情報・そのログとは混ざらないようにする。
 * Cron Trigger だけで動き、HTTP は受け付けない（公開URLも持たない設定）。
 */
import { runMonitor } from "./monitor.js";

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },

  // HTTP は受け付けない（workers_dev = false・ルート未設定のため通常は呼ばれない）
  async fetch() {
    return new Response("Not Found", { status: 404 });
  }
};
