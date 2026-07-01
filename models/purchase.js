const mongoose = require("mongoose");

const nestedPartSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  name: String,
  serialNumber: { type: String, required: true },
  barcode: { type: String },
  quantity: { type: Number, default: 1 },
  purchasePrice: { type: Number, default: 0 }
});

const purchaseItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productType: { type: String, enum: ["machine", "part", "single"], required: true },
  barcode: { type: String },      
  batchNumber: { type: String },  
  discount: { type: Number, default: 0 },
  serialNumber: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  purchasePrice: { type: Number, required: true }, 
  taxPercentage: { type: Number, default: 0 },
  lineTotal: { type: Number, required: true },
  linkedParts: [nestedPartSchema] 
});

const purchaseSchema = new mongoose.Schema({
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
  purchaseNumber: { type: String, required: true }, 
  date: { type: Date, default: Date.now },
  items: [purchaseItemSchema],
  subTotal: { type: Number, required: true },
  totalTax: { type: Number, default: 0 },
  grandTotal: { type: Number, required: true },
  amountPaid: { type: Number, default: 0 },
  paymentMethod: { type: String, default: "Cash" },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

// module.exports = mongoose.model("Purchase", purchaseSchema);
module.exports = mongoose.models.Purchase || mongoose.model("Purchase", purchaseSchema);