import dns from "dns/promises";
import SmtpSender from "../models/smtp-sender.model.js";
import SenderHealth from "../models/sender-health.model.js";

const RBL_LISTS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "b.barracudacentral.org",
];

function reverseIP(ip) {
  return ip.split(".").reverse().join(".");
}

async function checkRBL(ip) {
  const reversed = reverseIP(ip);
  const hits = [];

  for (const rbl of RBL_LISTS) {
    try {
      await dns.resolve4(`${reversed}.${rbl}`);
      hits.push(rbl);
    } catch {}
  }

  return hits;
}

(async () => {
  console.log("Advanced Blacklist Monitor Started");

  setInterval(
    async () => {
      const senders = await SmtpSender.findAll({
        where: { isVerified: true },
      });

      console.log(`🔍 Starting blacklist check for ${senders.length} senders...`);

      // 🚀 OPTIMIZATION: Process in parallel batches
      const BATCH_SIZE = 5;
      for (let i = 0; i < senders.length; i += BATCH_SIZE) {
        const batch = senders.slice(i, i + BATCH_SIZE);

        await Promise.allSettled(
          batch.map(async (sender) => {
            if (!sender.sendingIp) return;

            try {
              const hits = await checkRBL(sender.sendingIp);
              const blacklisted = hits.length > 0;

              // Update Health
              await SenderHealth.update(
                {
                  blacklisted,
                  reputationScore: blacklisted ? 20 : 80,
                  healthStatus: blacklisted ? "critical" : "healthy",
                  lastCheckedAt: new Date(),
                },
                { where: { senderId: sender.id } },
              );

              // Update Sender
              if (blacklisted) {
                await sender.update({ isPaused: true });
                console.log(
                  `🚨 Sender ${sender.email} blacklisted on: ${hits.join(", ")}`,
                );
              } else {
                // Only unpause if it was healthy before?
                // For now, let's just update the status
                if (sender.isPaused && !blacklisted) {
                  // await sender.update({ isPaused: false });
                  console.log(`✅ Sender ${sender.email} is clean`);
                }
              }
            } catch (err) {
              console.error(`❌ Blacklist check failed for ${sender.email}:`, err);
            }
          }),
        );
      }
      console.log("🏁 Blacklist check cycle complete");
    },
    60 * 60 * 1000,
  ); // hourly
})();
