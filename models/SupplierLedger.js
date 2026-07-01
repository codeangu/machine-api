const mongoose = require("mongoose");

const supplierLedgerSchema = new mongoose.Schema({
  supplier: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Supplier", 
    required: true 
  },
  date: { type: Date, default: Date.now },
  transactionType: { 
    type: String, 
    enum: ["Purchase", "Payment", "Return", "Opening Balance"], 
    required: true 
  },
  description: { type: String }, // e.g., "Bill #PUR-1001" ya "Paid via Cheque"
  
  // Accounting terms
  credit: { type: Number, default: 0 }, // Bill amount (Humein dena hai)
  debit: { type: Number, default: 0 },  // Paid amount (Humne de diya)
  
  runningBalance: { type: Number }, // Us waqt ka total balance kya tha
  
  referenceId: { type: mongoose.Schema.Types.ObjectId }, // Purchase ID ya Payment ID
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
});
 
// module.exports = mongoose.model("SupplierLedger", supplierLedgerSchema);
module.exports = mongoose.models.SupplierLedger || mongoose.model("SupplierLedger", supplierLedgerSchema);