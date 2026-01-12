import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";

export const enqueueEmailVerification = async (batchId) => {
  try {
    const channel = await getChannel();
    await channel.assertQueue(QUEUES.EMAIL_VERIFY, { durable: true });

    const message = JSON.stringify({
      batchId,
      enqueuedAt: new Date().toISOString(),
    });

    channel.sendToQueue(QUEUES.EMAIL_VERIFY, Buffer.from(message), {
      persistent: true,
      contentType: "application/json",
    });

    console.log(`✅ Batch ${batchId} enqueued for verification`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to enqueue batch ${batchId}:`, error);
    return false;
  }
};
