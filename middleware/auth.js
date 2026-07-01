const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  // ✅ Authorization Header Check
  const authHeader = req.header("Authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ msg: "Access denied. No token provided." });
  }
  
  try {
    const token = authHeader.split(" ")[1]; // Extract token from "Bearer <token>"
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Store decoded user data for use in route handlers
    next();
  } catch (err) {
    res.status(401).json({ msg: "Invalid token." });
  }
};

// Example of token generation (typically in a login/signup route):
// const generateToken = (payload) => {
//   return jwt.sign(payload, process.env.JWT_SECRET, {
//     expiresIn: '30d',  // Token expires in 30 days (~1 month)
//   });
// };






// const jwt = require("jsonwebtoken");

// module.exports = function (req, res, next) {
//   // ✅ Authorization Header Check
//   const authHeader = req.header("Authorization");

//   if (!authHeader || !authHeader.startsWith("Bearer ")) {
//     return res.status(401).json({ msg: "Access denied. No token provided." });
//   }

//   try {
//     const token = authHeader.split(" ")[1]; // "Bearer <token>" se token extract karna
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     req.user = decoded; // Token se user data extract karna
//     next();
//   } catch (err) {
//     res.status(400).json({ msg: "Invalid token." });
//   }
// };

