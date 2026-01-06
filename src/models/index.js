import User from "./user.model.js";
import Sender from "./sender.model.js";
import Campaign from "./campaign.model.js";
import Email from "./email.model.js";
import EmailEvent from "./email-event.model.js";
import ReplyEvent from "./reply-event.model.js";
import BounceEvent from "./bounce-event.model.js";

/* Associations */

// User → Campaigns
User.hasMany(Campaign, { foreignKey: "userId" });
Campaign.belongsTo(User, { foreignKey: "userId" });

// Sender → Campaigns
Sender.hasMany(Campaign, { foreignKey: "senderId" });
Campaign.belongsTo(Sender, { foreignKey: "senderId" });

Email.hasMany(EmailEvent, { foreignKey: "emailId" });
EmailEvent.belongsTo(Email, { foreignKey: "emailId" });

Email.hasMany(ReplyEvent, { foreignKey: "emailId" });
ReplyEvent.belongsTo(Email, { foreignKey: "emailId" });

Email.hasMany(BounceEvent, { foreignKey: "emailId" });
BounceEvent.belongsTo(Email, { foreignKey: "emailId" });;

export { User, Sender, Campaign };
