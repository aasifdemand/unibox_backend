import { deleteCachedData } from "./src/utils/redis-client.js";
import dotenv from "dotenv";
dotenv.config();

async function flush() {
    console.log("Flushing Outlook message caches...");
    await deleteCachedData("mailbox:outlook:*");
    console.log("Done.");
    process.exit(0);
}

flush().catch(err => {
    console.error(err);
    process.exit(1);
});
