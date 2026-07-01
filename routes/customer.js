const express = require("express");
const router = express.Router();
const Customer = require("../models/Customer");
const CustomerLedger = require("../models/CustomerLedger");
const auth = require("../middleware/auth");

// ==========================================
// 1. ADD NEW CUSTOMER
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const { name, phone, address, email, openingBalance, isWalking } = req.body;

    const customer = new Customer({
      name,
      phone,
      address,
      email,
      openingBalance: Number(openingBalance) || 0,
      isWalking,
      user: req.user.id
    });

    const savedCustomer = await customer.save();

    if (Number(openingBalance) !== 0) {
      const ledgerEntry = new CustomerLedger({
        customer: savedCustomer._id,
        transactionType: "Opening Balance",
        description: "Initial Balance at time of registration",
        debit: Number(openingBalance) > 0 ? Number(openingBalance) : 0,
        credit: Number(openingBalance) < 0 ? Math.abs(Number(openingBalance)) : 0,
        runningBalance: Number(openingBalance),
        user: req.user.id
      });
      await ledgerEntry.save();
    }

    res.status(201).json(savedCustomer);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 2. GET ALL CUSTOMERS
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const customers = await Customer.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(customers);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 3. GET SINGLE CUSTOMER (Ab Edit sahi kaam karega)
// ==========================================
router.get("/:id", auth, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, user: req.user.id });
    if (!customer) return res.status(404).json({ msg: "Customer nahi mila" });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 4. UPDATE CUSTOMER (Sirf Profile Info update karega)
// ==========================================
router.put("/:id", auth, async (req, res) => {
  try {
    const { name, phone, address, email, isWalking } = req.body;
    
    // Sirf wahi cheezein update hongi jo ledger ko kharab nahi karti
    const updatedCustomer = await Customer.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: { name, phone, address, email, isWalking } },
      { new: true }
    );

    if (!updatedCustomer) return res.status(404).json({ msg: "Customer nahi mila" });
    res.json(updatedCustomer);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 5. CUSTOMER PAYMENT
// ==========================================
router.post("/payment", auth, async (req, res) => {
  try {
    const { customerId, amount, note, transactionType, date } = req.body;
    const customer = await Customer.findById(customerId);
    if (!customer) return res.status(404).json({ msg: "Customer nahi mila" });

    const amt = Number(amount);
    const type = transactionType || "Payment";

    if (type === "Payment") {
      // Customer ne paisa diya → totalPaid barha → balance kama
      customer.totalPaid += amt;
    } else if (type === "Sale") {
      // Naya udhaar diya → totalSale barha → balance barha
      customer.totalSale += amt;
    }
    await customer.save();

    const ledger = new CustomerLedger({
      customer: customerId,
      transactionType: type,
      description: note || (type === "Payment" ? "Cash/Bank Received" : "Credit Sale / Udhaar"),
      debit:  type === "Sale"    ? amt : 0,
      credit: type === "Payment" ? amt : 0,
      runningBalance: customer.balance,
      date: date ? new Date(date) : new Date(),
      user: req.user.id
    });
    await ledger.save();

    res.json({ msg: "Transaction recorded", currentBalance: customer.balance });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 6. CUSTOMER LEDGER
// ==========================================
router.get("/ledger/:id", auth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ msg: "Customer nahi mila" });

    const rows = await CustomerLedger.find({ customer: req.params.id, user: req.user.id })
      .sort({ date: 1, _id: 1 });

    // Recompute running balance sequentially so the column is always correct
    // (debit = sale/charge raises balance, credit = payment lowers it)
    let running = 0;
    const ledger = rows.map((e) => {
      running += (e.debit || 0) - (e.credit || 0);
      const obj = e.toObject();
      obj.runningBalance = running;
      return obj;
    });

    const totalDebit = ledger.reduce((s, e) => s + (e.debit || 0), 0);
    const totalCredit = ledger.reduce((s, e) => s + (e.credit || 0), 0);
    res.json({
      customerName: customer.name,
      phone: customer.phone,
      openingBalance: customer.openingBalance,
      currentBalance: customer.balance,
      totalDebit,
      totalCredit,
      ledger
    });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ==========================================
// 7. DELETE CUSTOMER (only if no linked sales)
// ==========================================
router.delete("/:id", auth, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, user: req.user.id });
    if (!customer) return res.status(404).json({ msg: "Customer nahi mila" });

    const Sale = require("../models/Sale");
    const saleCount = await Sale.countDocuments({ customer: req.params.id, user: req.user.id });
    if (saleCount > 0) {
      return res.status(400).json({
        msg: "Is customer ki sales mojood hain — delete nahi ho sakta. Pehle related sales delete karein."
      });
    }

    await CustomerLedger.deleteMany({ customer: req.params.id, user: req.user.id });
    await customer.deleteOne();
    res.json({ msg: "Customer delete ho gaya" });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

module.exports = router;