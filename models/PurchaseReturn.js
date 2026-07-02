const mongoose = require("mongoose");

const purchaseReturnItemSchema = new mongoose.Schema({
  product:       { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName:   { type: String, default: "" },
  quantity:      { type: Number, required: true, min: 1 },
  purchasePrice: { type: Number, required: true, min: 0 },
  lineTotal:     { type: Number, required: true }
}, { _id: false });

const purchaseReturnSchema = new mongoose.Schema({
  originalPurchase: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", required: true },
  purchaseNumber:   { type: String, default: "" },     // original purchase invoice #
  returnNumber:     { type: String, required: true },  // e.g. PR-1042
  supplier:         { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
  supplierName:     { type: String, default: "" },
  date:             { type: Date, default: Date.now },
  items:            [purchaseReturnItemSchema],
  totalAmount:      { type: Number, required: true },
  reason:           { type: String, default: "" },
  user:             { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

module.exports = mongoose.models.PurchaseReturn || mongoose.model("PurchaseReturn", purchaseReturnSchema);
