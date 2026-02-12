// scripts/clean-outlook-sender.js
import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redis = new Redis(process.env.REDIS_URL);
const SENDER_ID = "caf43efe-556f-4283-8e50-600e25a97ab5";

const cleanOutlookSender = async () => {
  console.log(`🧹 Cleaning Redis for Outlook sender: ${SENDER_ID}`);
  console.log("=".repeat(60));

  try {
    // 1️⃣ Delete lastProcessed for this sender
    const lastProcessedKey = `reply:lastProcessed:${SENDER_ID}`;
    const lastDeleted = await redis.del(lastProcessedKey);
    console.log(`\n📊 LastProcessed key: ${lastProcessedKey}`);
    console.log(
      `   ✅ Deleted: ${lastDeleted === 1 ? "Yes" : "No (not found)"}`,
    );

    // 2️⃣ Delete all processed message IDs for this sender
    console.log(`\n📊 Scanning for reply:processed:${SENDER_ID}:* keys...`);
    let cursor = "0";
    let deletedCount = 0;
    let keysDeleted = [];

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `reply:processed:${SENDER_ID}:*`,
        "COUNT",
        "100",
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        const deleted = await redis.del(...keys);
        deletedCount += deleted;
        keysDeleted = [...keysDeleted, ...keys];
      }
    } while (cursor !== "0");

    console.log(`   ✅ Deleted ${deletedCount} processed message keys`);
    if (keysDeleted.length > 0) {
      console.log(
        `   📋 First 5 keys: ${keysDeleted.slice(0, 5).join("\n      ")}`,
      );
    }

    // 3️⃣ Verify cleanup
    const verifyLast = await redis.exists(lastProcessedKey);
    const verifyProcessed = await redis.keys(`reply:processed:${SENDER_ID}:*`);

    console.log("\n📋 Verification:");
    console.log(
      `   🔍 LastProcessed exists: ${verifyLast === 1 ? "❌ Yes" : "✅ No"}`,
    );
    console.log(`   🔍 Processed keys remaining: ${verifyProcessed.length}`);

    if (verifyProcessed.length === 0) {
      console.log(
        "\n✅ Sender fully cleaned! The worker will now start fresh.",
      );
      console.log(
        "   Next run will check from 1 hour ago and detect all replies.",
      );
    }

    console.log("\n" + "=".repeat(60));
  } catch (error) {
    console.error("\n❌ Cleanup failed:", error);
  } finally {
    await redis.quit();
  }
};

cleanOutlookSender();
