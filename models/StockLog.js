const mongoose = require("mongoose");

// Audit trail for manual stock / min-stock adjustments made from the
// Stock & Inventory screen (separate from purchase/sale driven changes).
const stockLogSchema = new mongoose.Schema({
  product:      { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  type:         { type: String, enum: ["Stock Adjustment", "Min Stock Update"], required: true },
  previousStock: { type: Number, default: 0 },
  newStock:      { type: Number, default: 0 },
  change:        { type: Number, default: 0 }, // newStock - previousStock (can be negative)
  previousMinStock: { type: Number, default: null },
  newMinStock:      { type: Number, default: null },
  reason:       { type: String, default: "" },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date:         { type: Date, default: Date.now }
});

module.exports = mongoose.models.StockLog || mongoose.model("StockLog", stockLogSchema);
