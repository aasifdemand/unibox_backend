
import "../src/models/index.js";
import { Campaign, CampaignStep } from "../src/models/index.js";

async function testSync() {
    console.log("Starting Step 0 Sync Test...");

    const campaign = await Campaign.create({
        userId: "ea813149-a699-43c2-b2c4-bc649a88ee6e",
        senderId: "75462dd7-6477-49d0-8081-1187ed77dcfa",
        senderType: "smtp",
        listBatchId: "d8b200ca-fd42-48a1-bb3e-caef44abb1f0",
        name: "Test Campaign Sync",
        subject: "Initial Subject",
        htmlBody: "Initial Body",
        status: "draft"
    });

    console.log("Created Campaign:", campaign.id);

    // Simulate Step 0 creation (orchestrator logic)
    await CampaignStep.upsert({
        campaignId: campaign.id,
        stepOrder: 0,
        subject: campaign.subject,
        htmlBody: campaign.htmlBody,
        textBody: "",
        delayMinutes: 0,
        condition: "always"
    });

    let step0 = await CampaignStep.findOne({ where: { campaignId: campaign.id, stepOrder: 0 } });
    console.log("Initial Step 0 Subject:", step0.subject);

    // Update Campaign
    await campaign.update({ subject: "Updated Subject" });
    console.log("Updated Campaign Subject to: Updated Subject");

    // Simulate Sync (updated orchestrator logic)
    await CampaignStep.upsert({
        campaignId: campaign.id,
        stepOrder: 0,
        subject: campaign.subject,
        htmlBody: campaign.htmlBody,
        textBody: "",
        delayMinutes: 0,
        condition: "always"
    });

    step0 = await CampaignStep.findOne({ where: { campaignId: campaign.id, stepOrder: 0 } });
    console.log("Final Step 0 Subject:", step0.subject);

    if (step0.subject === "Updated Subject") {
        console.log("✅ SUCCESS: Step 0 synchronized correctly.");
    } else {
        console.error("❌ FAILURE: Step 0 did not synchronize.");
    }

    // Cleanup
    await campaign.destroy({ force: true });
}

testSync().catch(console.error).finally(() => process.exit());
