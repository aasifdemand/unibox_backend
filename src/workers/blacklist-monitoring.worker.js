import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import SmtpSender from "../models/smtp-sender.model.js";
import { senderHealthService } from "../services/sender-health.service.js";

(async () => {
  console.log("🚀 Advanced Health & Blacklist Monitor Started");

  setInterval(
    async () => {
      try {
        const senders = await SmtpSender.findAll({
          where: { isVerified: true },
        });

        console.log(`🔍 Starting full health evaluation for ${senders.length} senders...`);

        // 🚀 Process in parallel batches
        const BATCH_SIZE = 5;
        for (let i = 0; i < senders.length; i += BATCH_SIZE) {
          const batch = senders.slice(i, i + BATCH_SIZE);

          await Promise.allSettled(
            batch.map(async (sender) => {
              try {
                const score = await senderHealthService.evaluateSender(sender.id);
                console.log(`✅ Sender ${sender.email} evaluated. Score: ${score}/100`);
              } catch (err) {
                console.error(`❌ Health evaluation failed for ${sender.email}:`, err);
              }
            }),
          );
        }
        console.log("🏁 Health evaluation cycle complete");
      } catch (err) {
        console.error("❌ Fatal error in health monitor cycle:", err);
      }
    },
    60 * 60 * 1000, // hourly
  );
})();
