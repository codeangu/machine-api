const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Purchase = require("../models/purchase");
const Product = require("../models/Product");
const Supplier = require("../models/supplier");
const SupplierLedger = require("../models/SupplierLedger");
const auth = require("../middleware/auth");

// ==========================================
// Helper: transaction with auto-retry on transient MongoDB
// write-conflicts (Atlas shared tier throws these intermittently)
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
        await new Promise(r => setTimeout(r, 60 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ==========================================
// HELPER: Items se totals + processedItems nikalna
// (Create aur Update dono route mein use hoga, isliye alag kar diya)
// ==========================================
function buildItemsAndTotals(items, header) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Kam az kam ek item add karna zaroori hai");
  }

  let subtotal = 0;
  let totalTax = 0;
  const processedItems = [];

  for (const item of items) {
    if (!item.productId) throw new Error("Har item mein product select karna zaroori hai");
    if (!item.quantity || item.quantity < 1) throw new Error("Quantity 1 se kam nahi ho sakti");

    const qty = Number(item.quantity);
    const unitCost = Number(item.unitCost) || 0;
    const discount = Number(item.discount) || 0;
    const taxPct = Number(item.taxPercentage) || 0;

    const lineSub = (qty * unitCost) - discount;
    const lineTax = lineSub * (taxPct / 100);
    const lineTotal = lineSub + lineTax;

    subtotal += lineSub;
    totalTax += lineTax;

    processedItems.push({
      product: item.productId,
      productType: item.type,
      barcode: item.barcode,
      batchNumber: header.invoiceNumber, // Invoice Number ko hi Batch Number bana diya
      serialNumber: item.serialNumber,
      quantity: qty,
      purchasePrice: unitCost,
      taxPercentage: taxPct,
      discount: discount,
      lineTotal: lineTotal,
      linkedParts: item.linkedParts || []
    });
  }

  const grandTotal = subtotal + totalTax;
  return { subtotal, totalTax, grandTotal, processedItems };
}

// ==========================================
// 1. CREATE PURCHASE (Purchase Order / Bill Entry)
// ==========================================

router.post("/", auth, async (req, res) => {
  try {
    const { header, items, amountPaid } = req.body;

    if (!header || !header.supplierId) throw new Error("Supplier select karna zaroori hai");
    if (!header.invoiceNumber) throw new Error("Invoice number zaroori hai");

    const newPurchaseId = await withTxnRetry(async (session) => {
      const supplierDoc = await Supplier.findOne({ _id: header.supplierId, user: req.user.id }).session(session);
      if (!supplierDoc) throw new Error("Supplier nahi mila!");

      // Same invoice number dobara na bane (per user)
      const dupe = await Purchase.findOne({ purchaseNumber: header.invoiceNumber, user: req.user.id }).session(session);
      if (dupe) throw new Error(`Invoice #${header.invoiceNumber} pehle se mojood hai`);

      // Totals ab YAHIN calculate honge — frontend ki value sirf reference, trust nahi
      const { subtotal, totalTax, grandTotal, processedItems } = buildItemsAndTotals(items, header);

      const paid = Number(amountPaid) || 0;
      if (paid > grandTotal) throw new Error("Amount Paid, Grand Total se zyada nahi ho sakta");

      // Stock update + product existence check
      for (const item of processedItems) {
        const productDoc = await Product.findOne({ _id: item.product, user: req.user.id }).session(session);
        if (!productDoc) throw new Error(`Product nahi mila (ID: ${item.product})`);

        productDoc.currentStock = (productDoc.currentStock || 0) + item.quantity;
        productDoc.unitPrice = item.purchasePrice;
        if (item.barcode) productDoc.barcode = item.barcode;
        await productDoc.save({ session });
      }

      const newPurchase = new Purchase({
        supplier: header.supplierId,
        purchaseNumber: header.invoiceNumber,
        date: header.invoiceDate,
        items: processedItems,
        subTotal: subtotal,
        totalTax: totalTax,
        grandTotal: grandTotal,
        amountPaid: paid,
        user: req.user.id
      });

      await newPurchase.save({ session });

      // --- Supplier & Ledger ---
      supplierDoc.totalPurchase += grandTotal;
      supplierDoc.totalPaid += paid;
      await supplierDoc.save({ session });

      const ledger = new SupplierLedger({
        supplier: header.supplierId,
        transactionType: "Purchase",
        description: `Invoice #${header.invoiceNumber}`,
        credit: grandTotal,
        debit: paid,
        runningBalance: supplierDoc.balance,
        referenceId: newPurchase._id,
        user: req.user.id
      });
      await ledger.save({ session });

      return newPurchase._id;
    });

    res.status(201).json({ msg: "Purchase saved with Batch & Barcode", id: newPurchaseId });

  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});


// ==========================================
// 2. FETCH PURCHASES (List & Detail)
// ==========================================

// @route   GET /api/purchase
// @desc    Saray purchase transactions dekhna (with populates)
router.get("/", auth, async (req, res) => {
  try {
    const userFilter = (req.query.admin === "true" && req.user.role === "admin") ? {} : { user: req.user.id };
    const { from, to } = req.query;
    if (from || to) {
      userFilter.date = {};
      if (from) userFilter.date.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        userFilter.date.$lte = toDate;
      }
    }
    const purchases = await Purchase.find(userFilter)
      .populate("supplier", "name companyName phone")
      .populate("items.product", "name sku type unit")
      .sort({ date: -1 });
    res.json(purchases);
  } catch (err) {
    console.error("Fetch purchases error:", err.message);
    res.status(500).json({ msg: "Server Error: Fetching purchases failed" });
  }
});

// @route   GET /api/purchase/supplier/:supplierId
// @desc    Ek supplier ki saari purchases (ledger / reports ke liye zaroori)
router.get("/supplier/:supplierId", auth, async (req, res) => {
  try {
    const purchases = await Purchase.find({ supplier: req.params.supplierId, user: req.user.id })
      .populate("items.product", "name sku type unit")
      .sort({ date: -1 });
    res.json(purchases);
  } catch (err) {
    console.error("Fetch supplier purchases error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});

// @route   GET /api/purchase/:id
// @desc    Single purchase detail
router.get("/:id", auth, async (req, res) => {
  try {
    const purchase = await Purchase.findOne({ _id: req.params.id, user: req.user.id })
      .populate("supplier", "name companyName phone address email")
      .populate("items.product", "name sku type unit purchasePrice sellingPrice");

    if (!purchase) {
      return res.status(404).json({ msg: "Purchase invoice not found" });
    }
    res.json(purchase);
  } catch (err) {
    console.error("Fetch single purchase error:", err.message);
    res.status(500).json({ msg: "Server Error" });
  }
});


// ==========================================
// 3. UPDATE PURCHASE (Edit Bill)
//    Logic: purana stock/supplier/ledger effect reverse karo,
//    phir naye data ke sath dobara apply karo — sab ek hi transaction mein
// ==========================================

// @route   PUT /api/purchase/:id
router.put("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { header, items, amountPaid } = req.body;

    if (!header || !header.supplierId) throw new Error("Supplier select karna zaroori hai");
    if (!header.invoiceNumber) throw new Error("Invoice number zaroori hai");

    const oldPurchase = await Purchase.findOne({ _id: req.params.id, user: req.user.id }).session(session);
    if (!oldPurchase) throw new Error("Purchase record nahi mila");

    const oldSupplierDoc = await Supplier.findOne({ _id: oldPurchase.supplier, user: req.user.id }).session(session);
    if (!oldSupplierDoc) throw new Error("Purani supplier record nahi mili");

    // Invoice number kisi aur (apne ilawa) record mein duplicate na ho
    const dupe = await Purchase.findOne({
      purchaseNumber: header.invoiceNumber,
      user: req.user.id,
      _id: { $ne: oldPurchase._id }
    }).session(session);
    if (dupe) throw new Error(`Invoice #${header.invoiceNumber} pehle se mojood hai`);

    // ---------- STEP 1: PURANA STOCK EFFECT REVERSE KARO ----------
    for (const oldItem of oldPurchase.items) {
      const productDoc = await Product.findOne({ _id: oldItem.product, user: req.user.id }).session(session);
      if (productDoc) {
        if ((productDoc.currentStock || 0) < oldItem.quantity) {
          throw new Error(`"${productDoc.productName}" ka stock pehle hi sale ho chuka hai, isliye edit nahi ho sakta. Pehle related sale adjust karein.`);
        }
        productDoc.currentStock -= oldItem.quantity;
        await productDoc.save({ session });
      }
    }

    // ---------- STEP 2: PURANA SUPPLIER & LEDGER EFFECT REVERSE KARO ----------
    oldSupplierDoc.totalPurchase -= oldPurchase.grandTotal;
    oldSupplierDoc.totalPaid -= oldPurchase.amountPaid;
    await oldSupplierDoc.save({ session });
    await SupplierLedger.deleteMany({ referenceId: oldPurchase._id, user: req.user.id }).session(session);

    // ---------- STEP 3: NAYI SUPPLIER CONFIRM KARO (agar form mein supplier change hui ho) ----------
    const supplierChanged = header.supplierId.toString() !== oldPurchase.supplier.toString();
    const newSupplierDoc = supplierChanged
      ? await Supplier.findOne({ _id: header.supplierId, user: req.user.id }).session(session)
      : oldSupplierDoc;
    if (!newSupplierDoc) throw new Error("Nayi supplier nahi mili");

    // ---------- STEP 4: NAYE TOTALS CALCULATE KARO (server-side, trusted) ----------
    const { subtotal, totalTax, grandTotal, processedItems } = buildItemsAndTotals(items, header);

    const paid = Number(amountPaid) || 0;
    if (paid > grandTotal) throw new Error("Amount Paid, Grand Total se zyada nahi ho sakta");

    // ---------- STEP 5: NAYA STOCK EFFECT APPLY KARO ----------
    for (const item of processedItems) {
      const productDoc = await Product.findOne({ _id: item.product, user: req.user.id }).session(session);
      if (!productDoc) throw new Error(`Product nahi mila (ID: ${item.product})`);

      productDoc.currentStock = (productDoc.currentStock || 0) + item.quantity;
      productDoc.unitPrice = item.purchasePrice;
      if (item.barcode) productDoc.barcode = item.barcode;
      await productDoc.save({ session });
    }

    // ---------- STEP 6: PURCHASE DOCUMENT UPDATE KARO ----------
    oldPurchase.supplier = header.supplierId;
    oldPurchase.purchaseNumber = header.invoiceNumber;
    oldPurchase.date = header.invoiceDate;
    oldPurchase.items = processedItems;
    oldPurchase.subTotal = subtotal;
    oldPurchase.totalTax = totalTax;
    oldPurchase.grandTotal = grandTotal;
    oldPurchase.amountPaid = paid;
    await oldPurchase.save({ session });

    // ---------- STEP 7: NAYI SUPPLIER & LEDGER APPLY KARO ----------
    newSupplierDoc.totalPurchase += grandTotal;
    newSupplierDoc.totalPaid += paid;
    await newSupplierDoc.save({ session });

    const ledger = new SupplierLedger({
      supplier: header.supplierId,
      transactionType: "Purchase",
      description: `Invoice #${header.invoiceNumber} (Edited)`,
      credit: grandTotal,
      debit: paid,
      runningBalance: newSupplierDoc.balance,
      referenceId: oldPurchase._id,
      user: req.user.id
    });
    await ledger.save({ session });

    await session.commitTransaction();
    res.json({ msg: "Purchase update ho gayi", id: oldPurchase._id });

  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ msg: err.message });
  } finally {
    session.endSession();
  }
});


// ==========================================
// 4. REVERSE/DELETE PURCHASE (Audit rollback)
// ==========================================

// @route   DELETE /api/purchase/:id
router.delete("/:id", auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const purchase = await Purchase.findOne({ _id: req.params.id, user: req.user.id }).session(session);
    if (!purchase) {
      return res.status(404).json({ msg: "Purchase record not found" });
    }

    const supplierDoc = await Supplier.findOne({ _id: purchase.supplier, user: req.user.id }).session(session);
    if (!supplierDoc) {
      throw new Error("Supplier linked to this purchase was not found");
    }

    // 1. Stock Check & Rollback
    for (const item of purchase.items) {
      const productDoc = await Product.findOne({ _id: item.product, user: req.user.id }).session(session);
      if (productDoc) {
        // AGER STOCK SALE HO GYA HAI TO DELETE NAHI HOGA
        if (productDoc.currentStock < item.quantity) {
          throw new Error(`Product "${productDoc.productName}" ka stock sale ho chuka hai. Pehle sale delete karein ya stock adjust karein.`);
        }

        // Stock wapis kam karo
        productDoc.currentStock -= item.quantity;
        await productDoc.save({ session });
      }
    }

    // 2. Rollback supplier values
    supplierDoc.totalPurchase -= purchase.grandTotal;
    supplierDoc.totalPaid -= purchase.amountPaid;
    await supplierDoc.save({ session });

    // 3. Delete old Ledger entries
    await SupplierLedger.deleteMany({ referenceId: purchase._id, user: req.user.id }).session(session);

    // 4. Audit Trail (Optional but professional)
    const auditLedger = new SupplierLedger({
      supplier: purchase.supplier,
      transactionType: "Return",
      description: `VOID / CANCELED: Purchase Bill #${purchase.purchaseNumber}`,
      debit: purchase.grandTotal,
      credit: purchase.amountPaid,
      runningBalance: supplierDoc.balance,
      user: req.user.id
    });
    await auditLedger.save({ session });

    // 5. Delete purchase record
    await purchase.deleteOne({ session });

    await session.commitTransaction();
    res.json({ msg: `Purchase bill #${purchase.purchaseNumber} deleted and stock adjusted.` });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ msg: err.message || "Failed to cancel purchase" });
  } finally {
    session.endSession();
  }
});

module.exports = router;