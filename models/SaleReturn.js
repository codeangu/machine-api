const mongoose = require("mongoose");

const saleReturnItemSchema = new mongoose.Schema({
  product:     { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, default: "" },
  quantity:    { type: Number, required: true, min: 1 },
  salePrice:   { type: Number, required: true, min: 0 },
  lineTotal:   { type: Number, required: true }
}, { _id: false });

const saleReturnSchema = new mongoose.Schema({
  originalSale:  { type: mongoose.Schema.Types.ObjectId, ref: "Sale", required: true },
  invoiceNumber: { type: String, default: "" },      // original sale invoice #
  returnNumber:  { type: String, required: true },   // e.g. SR-1042
  customer:      { type: mongoose.Schema.Types.ObjectId, ref: "Customer" }, // optional (walking)
  customerName:  { type: String, default: "Walking Customer" },
  date:          { type: Date, default: Date.now },
  items:         [saleReturnItemSchema],
  totalAmount:   { type: Number, required: true },
  reason:        { type: String, default: "" },
  user:          { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

module.exports = mongoose.models.SaleReturn || mongoose.model("SaleReturn", saleReturnSchema);
