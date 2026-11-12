/**
 * backend/models/ReminderNotification.js
 * Notifications sent to patients regarding reminders (e.g. missed doses).
 */

const { defineModel, schema: defineSchema } = require('../db/model');

const ReminderNotificationSchema = defineSchema(
  {
    reminderId: { type: String, required: true, index: true },
    patientId:  { type: String, required: true, index: true },
    date:       { type: String, required: true },
    time:       { type: String, required: true },
    message:    { type: String, required: true },
    status:     { type: String, default: "sent" },
    auditId:    { type: String, default: "" },
    sentAt:     { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = defineModel("ReminderNotification", ReminderNotificationSchema);
