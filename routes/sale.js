const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const CustomerLedger = require("../models/CustomerLedger");
const auth = require("../middleware/auth");

// ==========================================
// Helper: run a transaction with auto-retry on transient
// MongoDB conflicts ("Write conflict ... yielding is disabled").
// Atlas shared tiers throw these intermittently — retry is the
// official recommended handling.
// ==========================================
async function withTxnRetry(fn, maxRetries = 4) {
  let attempt = 0;
  while (true) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(session);
      await session.commitTransaction();
      session.endSession();
      return result;
    } catch (err) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();

      const labels = err.errorLabels || [];
      const transient = labels.includes("TransientTransactionError") ||
                        labels.includes("UnknownTransactionCommitResult");
      const writeConflict = err.code === 112 || /write conflict/i.test(err.message || "");

      if ((transient || writeConflict) && attempt < maxRetries) {
        attempt++;
        await new Promise(r => setTimeout(r, 60 * attempt)); // small backoff
        continue;
      }
      throw err;
    }
  }
}

// ==========================================
// 1. CREATE SALE (Sale Invoice Entry)
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const { customerId, customerName, invoiceNumber, items, discount, grandTotal, amountReceived } = req.body;

    const newSaleId = await withTxnRetry(async (session) => {
      // A. Stock Check & Update logic
      for (const item of items) {
        const product = await Product.findById(item.productId).session(session);
        if (!product) throw new Error(`Product nahi mila: ${item.productId}`);

        // ✅ Check currentStock (Jo ke asal warehouse stock hai)
        if (product.currentStock < item.quantity) {
          throw new Error(`Stock kam hai! ${product.productName} sirf ${product.currentStock} bacha hai.`);
        }

        // ✅ currentStock ko minus karein (Sale par yehi variable kam hota hai)
        product.currentStock -= item.quantity;
        await product.save({ session });

        // Profit tracking ke liye purchasePrice item mein add kar do
        item.purchasePriceAtTime = product.unitPrice || 0;
      }

      // B. Create Sale Entry
      const newSale = new Sale({
        customer: customerId || null,
        customerName: customerName || "Walking Customer",
        invoiceNumber,
        items: items.map(i => ({
          product: i.productId,
          quantity: i.quantity,
          salePrice: i.salePrice,
          purchasePriceAtTime: i.purchasePriceAtTime,
          lineTotal: i.lineTotal
        })),
        subTotal: Number(grandTotal) + Number(discount),
        discount: Number(discount),
        grandTotal: Number(grandTotal),
        amountReceived: Number(amountReceived),
        user: req.user.id
      });
      await newSale.save({ session });

      // C. Customer Ledger Update (Only if not walking customer)
      if (customerId) {
        const customer = await Customer.findOne({ _id: customerId, user: req.user.id }).session(session);
        if (customer) {
          customer.totalSale += Number(grandTotal);
          customer.totalPaid += Number(amountReceived);
          await customer.save({ session });

          const ledger = new CustomerLedger({
            customer: customerId,
            transactionType: "Sale",
            description: `Invoice #${invoiceNumber}`,
            debit: Number(grandTotal),     // Udhaar barha
            credit: Number(amountReceived), // Paise mil gaye
            runningBalance: customer.balance,
            referenceId: newSale._id,
            user: req.user.id
          });
          await ledger.save({ session });
        }
      }

      return newSale._id;
    });

    res.status(201).json({ msg: "Sale saved successfully", id: newSaleId });

  } catch (err) {
    console.error("Sale Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  }
});

// ==========================================
// 2. SALES HISTORY REPORT
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let filter = { user: req.user.id };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = toDate;
      }
    }
    const sales = await Sale.find(filter)
      .populate("customer", "name phone")
      .sort({ createdAt: -1 });
    res.json(sales);
  } catch (err) {
    res.status(500).json({ msg: "Fetch sales error" });
  }
});

// ==========================================
// 3. SINGLE SALE DETAIL (Invoice Print)
// ==========================================
router.get("/:id", auth, async (req, res) => {
  try {
    const sale = await Sale.findOne({ _id: req.params.id, user: req.user.id })
      .populate("customer", "name phone address email")
      .populate("items.product", "productName model brand");
    
    if (!sale) return res.status(404).json({ msg: "Invoice nahi mila" });
    res.json(sale);
  } catch (err) {
    res.status(500).json({ msg: "Detail fetch error" });
  }
});

// ==========================================
// 4. PROFIT & LOSS REPORT
// ==========================================
router.get("/report/profit", auth, async (req, res) => {
  try {
    const sales = await Sale.find({ user: req.user.id });
    let revenue = 0;
    let cost = 0;

    sales.forEach(sale => {
      revenue += sale.grandTotal;
      sale.items.forEach(item => {
        cost += (item.purchasePriceAtTime * item.quantity);
      });
    });

    res.json({
      totalSales: revenue,
      totalCost: cost,
      netProfit: revenue - cost,
      profitMargin: revenue > 0 ? ((revenue - cost) / revenue * 100).toFixed(2) + "%" : "0%"
    });
  } catch (err) {
    res.status(500).json({ msg: "Profit report error" });
  }
});

// ==========================================
// 5. SINGLE PRODUCT PERFORMANCE REPORT
// ==========================================
router.get("/report/product/:productId", auth, async (req, res) => {
  try {
    const { productId } = req.params;

    const sales = await Sale.find({ 
      user: req.user.id, 
      "items.product": productId 
    }).populate("items.product", "productName model brand");

    let totalQtySold = 0;
    let totalRevenue = 0;
    let totalCost = 0;
    let productName = "";

    sales.forEach(sale => {
      const productItems = sale.items.filter(item => item.product._id.toString() === productId);
      
      productItems.forEach(item => {
        totalQtySold += item.quantity;
        totalRevenue += item.lineTotal;
        totalCost += (item.purchasePriceAtTime * item.quantity);
        productName = item.product.productName;
      });
    });

    res.json({
      productId,
      productName,
      summary: {
        totalSold: totalQtySold,
        totalRevenue: totalRevenue,
        totalPurchaseCost: totalCost,
        netProfit: totalRevenue - totalCost,
        profitPercentage: totalCost > 0 ? ((totalRevenue - totalCost) / totalCost * 100).toFixed(2) + "%" : "0%"
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Product report error" });
  }
});
// ==========================================
// 6. UPDATE SALE (Sale Edit Logic)
// ==========================================
router.put("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { customerId, customerName, invoiceNumber, items, discount, grandTotal, amountReceived } = req.body;

    // 1. Purani Sale dhundein taake stock wapis sahi kiya ja sake
    const oldSale = await Sale.findById(req.params.id).session(session);
    if (!oldSale) throw new Error("Purana record nahi mila");

    // 2. REVERSE OLD STOCK: Purani items ka stock wapis plus karein
    for (const oldItem of oldSale.items) {
      await Product.findByIdAndUpdate(
        oldItem.product,
        { $inc: { currentStock: oldItem.quantity } },
        { session }
      );
    }

    // 3. APPLY NEW STOCK: Nayi items ka stock minus karein aur stock check karein
    for (const item of items) {
      const product = await Product.findById(item.productId).session(session);
      if (!product) throw new Error(`Product nahi mila: ${item.productId}`);
      
      if (product.currentStock < item.quantity) {
        throw new Error(`Stock kam hai! ${product.productName} sirf ${product.currentStock} bacha hai.`);
      }

      product.currentStock -= item.quantity;
      await product.save({ session });
      item.purchasePriceAtTime = product.unitPrice || 0; 
    }

    // 4. Update Sale Document
    const updatedSale = await Sale.findByIdAndUpdate(
      req.params.id,
      {
        customer: customerId || null,
        customerName: customerName || "Walking Customer",
        items: items.map(i => ({
          product: i.productId,
          quantity: i.quantity,
          salePrice: i.salePrice,
          purchasePriceAtTime: i.purchasePriceAtTime,
          lineTotal: i.lineTotal
        })),
        subTotal: Number(grandTotal) + Number(discount),
        discount: Number(discount),
        grandTotal: Number(grandTotal),
        amountReceived: Number(amountReceived),
      },
      { new: true, session }
    );

    // Reverse the OLD sale's effect on the OLD customer's running totals
    if (oldSale.customer) {
      const oldCust = await Customer.findById(oldSale.customer).session(session);
      if (oldCust) {
        oldCust.totalSale -= oldSale.grandTotal;
        oldCust.totalPaid -= oldSale.amountReceived;
        await oldCust.save({ session });
      }
    }

    // Remove the old ledger rows tied to this invoice
    await CustomerLedger.deleteMany({ referenceId: oldSale._id }).session(session);

    // Apply the NEW sale's effect on the (possibly changed) customer
    if (customerId) {
      const newCust = await Customer.findById(customerId).session(session);
      if (newCust) {
        newCust.totalSale += Number(grandTotal);
        newCust.totalPaid += Number(amountReceived);
        await newCust.save({ session });

        const ledger = new CustomerLedger({
          customer: newCust._id,
          transactionType: "Sale Update",
          description: `Updated Invoice #${invoiceNumber}`,
          debit: Number(grandTotal),
          credit: Number(amountReceived),
          runningBalance: newCust.balance,
          referenceId: updatedSale._id,
          user: req.user.id
        });
        await ledger.save({ session });
      }
    }

    await session.commitTransaction();
    res.json({ msg: "Sale updated successfully", id: updatedSale._id });

  } catch (err) {
    await session.abortTransaction();
    console.error("Update Sale Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  } finally {
    session.endSession();
  }
});

// ==========================================
// 7. DELETE SALE (Stock + Ledger rollback)
// ==========================================
router.delete("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const sale = await Sale.findOne({ _id: req.params.id, user: req.user.id }).session(session);
    if (!sale) return res.status(404).json({ msg: "Sale invoice nahi mila" });

    // 1. Stock wapis add karein (sale reverse)
    for (const item of sale.items) {
      await Product.findByIdAndUpdate(
        item.product,
        { $inc: { currentStock: item.quantity } },
        { session }
      );
    }

    // 2. Customer balance + ledger reverse karein
    if (sale.customer) {
      const customer = await Customer.findById(sale.customer).session(session);
      if (customer) {
        customer.totalSale -= sale.grandTotal;
        customer.totalPaid -= sale.amountReceived;
        await customer.save({ session });
      }
      await CustomerLedger.deleteMany({ referenceId: sale._id }).session(session);
    }

    // 3. Sale delete karein
    await sale.deleteOne({ session });

    await session.commitTransaction();
    res.json({ msg: `Sale #${sale.invoiceNumber} deleted, stock & ledger adjusted.` });
  } catch (err) {
    await session.abortTransaction();
    console.error("Delete Sale Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  } finally {
    session.endSession();
  }
});

module.exports = router;