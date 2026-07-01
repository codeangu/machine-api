const mongoose = require("mongoose");

const saleItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  quantity: { type: Number, required: true },
  salePrice: { type: Number, required: true },
  purchasePriceAtTime: { type: Number, required: true }, // ✅ Profit nikalne ke liye
  lineTotal: { type: Number, required: true }
});

const saleSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" }, // Optional for Walking
  customerName: { type: String }, // For Walking Customer name
  invoiceNumber: { type: String, required: true },
  date: { type: Date, default: Date.now },
  items: [saleItemSchema],
  subTotal: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  grandTotal: { type: Number, required: true },
  amountReceived: { type: Number, default: 0 },
  paymentMethod: { type: String, default: "Cash" },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

// module.exports = mongoose.model("Sale", saleSchema);
module.exports = mongoose.models.Sale || mongoose.model("Sale", saleSchema);
