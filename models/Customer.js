const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, default: "" },
  address: { type: String, default: "" },
  email: { type: String, default: "" },
  isWalking: { type: Boolean, default: false }, // ✅ Walking customer filter ke liye
  
  openingBalance: { type: Number, default: 0 },
  totalSale: { type: Number, default: 0 },
  totalPaid: { type: Number, default: 0 },
  balance: { type: Number, default: 0 }, // (Opening + TotalSale - TotalPaid)

  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
});

// Balance calculate karne ke liye pre-save hook
customerSchema.pre("save", function (next) {
  this.balance = this.openingBalance + this.totalSale - this.totalPaid;
  next();
});

// module.exports = mongoose.model("Customer", customerSchema);
module.exports = mongoose.models.Customer || mongoose.model("Customer", customerSchema);