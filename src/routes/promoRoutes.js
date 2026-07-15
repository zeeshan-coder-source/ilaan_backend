import { Router } from 'express';
import {
  validatePromoCode,
  getPromoCodes,
  createPromoCode,
  deletePromoCode,
  togglePromoCode
} from '../controllers/promoController.js';

const router = Router();

// Public validation
router.post('/validate', validatePromoCode);

// Admin CRUD routes
router.get('/', getPromoCodes);
router.post('/', createPromoCode);
router.delete('/:id', deletePromoCode);
router.patch('/:id/toggle', togglePromoCode);

export default router;
