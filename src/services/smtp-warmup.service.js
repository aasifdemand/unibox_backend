class SmtpWarmupService {
  getDailyLimit(daysActive) {
    if (daysActive <= 1) return 20;
    if (daysActive <= 2) return 40;
    if (daysActive <= 4) return 80;
    if (daysActive <= 6) return 150;
    return 300;
  }

  calculateDaysActive(sender) {
    const diff = Date.now() - new Date(sender.createdAt).getTime();
    return Math.floor(diff / 86400000);
  }

  async getSenderDailyLimit(sender) {
    const days = this.calculateDaysActive(sender);
    return this.getDailyLimit(days);
  }
}

export const smtpWarmupService = new SmtpWarmupService();
