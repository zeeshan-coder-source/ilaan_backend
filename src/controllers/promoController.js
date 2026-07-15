import prisma from '../config/db.js';

/**
 * Validate a promo code
 */
export const validatePromoCode = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Promo code is required' });
    }

    const promo = await prisma.promoCode.findUnique({
      where: { code: code.trim().toUpperCase() }
    });

    if (!promo || !promo.active) {
      return res.status(404).json({ success: false, message: 'Invalid or inactive promo code' });
    }

    if (promo.expiryDate && new Date(promo.expiryDate) < new Date()) {
      return res.status(400).json({ success: false, message: 'Promo code has expired' });
    }

    res.status(200).json({
      success: true,
      message: 'Promo code applied successfully',
      data: {
        code: promo.code,
        discountType: promo.discountType,
        value: promo.value
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all promo codes (Admin)
 */
export const getPromoCodes = async (req, res, next) => {
  try {
    const promos = await prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' }
    });

    res.status(200).json({
      success: true,
      data: promos
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new promo code (Admin)
 */
export const createPromoCode = async (req, res, next) => {
  try {
    const { code, discountType, value, expiryDate } = req.body;
    if (!code || !discountType || value === undefined) {
      return res.status(400).json({ success: false, message: 'Code, discountType and value are required' });
    }

    const uppercaseCode = code.trim().toUpperCase();

    // Check if duplicate
    const existing = await prisma.promoCode.findUnique({ where: { code: uppercaseCode } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Promo code already exists' });
    }

    const promo = await prisma.promoCode.create({
      data: {
        code: uppercaseCode,
        discountType,
        value: parseFloat(value),
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        active: true
      }
    });

    res.status(201).json({
      success: true,
      message: 'Promo code created successfully',
      data: promo
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a promo code (Admin)
 */
export const deletePromoCode = async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.promoCode.delete({
      where: { id: parseInt(id, 10) }
    });

    res.status(200).json({
      success: true,
      message: 'Promo code deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Toggle active status of a promo code (Admin)
 */
export const togglePromoCode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const promo = await prisma.promoCode.findUnique({
      where: { id: parseInt(id, 10) }
    });

    if (!promo) {
      return res.status(404).json({ success: false, message: 'Promo code not found' });
    }

    const updated = await prisma.promoCode.update({
      where: { id: parseInt(id, 10) },
      data: { active: !promo.active }
    });

    res.status(200).json({
      success: true,
      message: `Promo code ${updated.active ? 'activated' : 'deactivated'}`,
      data: updated
    });
  } catch (error) {
    next(error);
  }
};
