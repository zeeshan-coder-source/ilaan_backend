import { Router } from 'express';
import {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart
} from '../controllers/cartController.js';

const router = Router();

router.get('/', getCart);
router.post('/add', addToCart);
router.post('/update', updateCartItem);
router.post('/remove', removeFromCart);
router.post('/clear', clearCart);

export default router;
