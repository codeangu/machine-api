const mongoose = require("mongoose");

const customerLedgerSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  date: { type: Date, default: Date.now },
  transactionType: { 
    type: String, 
    enum: ["Sale", "Payment", "Return", "Opening Balance", "Sale Update"],
    required: true 
  },
  description: { type: String },
  debit: { type: Number, default: 0 },  // Invoice amount (Humne lena hai)
  credit: { type: Number, default: 0 }, // Received amount (Usne de diya)
  runningBalance: { type: Number },
  referenceId: { type: mongoose.Schema.Types.ObjectId }, // Sale ID
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
});

module.exports = mongoose.model("CustomerLedger", customerLedgerSchema);