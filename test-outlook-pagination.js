import dotenv from "dotenv";
dotenv.config();
import OutlookSender from "./src/models/outlook-sender.model.js";
import { getValidMicrosoftToken } from "./src/utils/get-valid-microsoft-token.js";
import axios from "axios";
import sequelize from "./src/config/db.js";

async function test() {
    await sequelize.authenticate();
    const sender = await OutlookSender.findOne({ where: { isVerified: true } });
    if (!sender) {
        console.log("No sender found");
        process.exit(0);
    }
    const token = await getValidMicrosoftToken(sender);
    const client = axios.create({
        baseURL: "https://graph.microsoft.com/v1.0",
        headers: { Authorization: `Bearer ${token}` }
    });

    const res = await client.get("/me/mailFolders/inbox/messages?$top=10&$count=true");
    console.log("Next link:", res.data["@odata.nextLink"]);

    if (res.data["@odata.nextLink"]) {
        const url = new URL(res.data["@odata.nextLink"]);
        console.log("URL Params:");
        for (const [key, value] of url.searchParams.entries()) {
            console.log(`${key}: ${value}`);
        }
    }
    process.exit(0);
}

test().catch(console.error);
