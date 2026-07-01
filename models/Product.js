const mongoose = require("mongoose");

const partItemSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true },
    sku:      { type: String, required: true },
    qty:      { type: Number, required: true, min: 1 },
    unitCost: { type: Number, required: true, min: 0 },
    serialNo: { type: String, default: "" }
  },
  { _id: false }
);

const productSchema = new mongoose.Schema({
  productName:       { type: String, required: true },
  model:             { type: String, required: true },
  brand:             { type: String, required: true },
  manufacturingYear: { type: String, required: true },
  type:              { type: String, enum: ["single", "machine"], required: true },
  notes:             { type: String, default: "" },

  unitPrice:    { type: Number, default: null },
  initialStock: { type: Number, default: null }, // product banate waqt shuru ka stock (record ke liye)
  currentStock: { type: Number, default: 0 },     // YE FIELD MISSING THI — purchase/sale isi ko update karte hain
  minStock:     { type: Number, default: null },

  parts:       { type: [partItemSchema], default: [] },
  serialNo:    { type: String, default: "" },
  condition:   { type: String, default: "" },
  accessories: { type: String, default: "" },
  printerType: { type: String, default: "" },
  barcode:     { type: String, default: "" },   // purchase route is field ko set karta hai, schema mein nahi thi

  user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
});

// Naya product create hote waqt currentStock ko initialStock ke barabar set kar do
// (taake har naye product ka baseline sahi ho, phir purchase/sale isi ko adjust karein)
productSchema.pre("save", function (next) {
  if (this.isNew && (this.currentStock === undefined || this.currentStock === null)) {
    this.currentStock = this.initialStock || 0;
  }
  next();
});

module.exports = mongoose.models.Product || mongoose.model("Product", productSchema);