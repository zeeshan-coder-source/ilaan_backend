import { Router } from 'express';
import healthRoutes from './healthRoutes.js';
import contactRoutes from './contactRoutes.js';
import productRoutes from './productRoutes.js';
import cartRoutes from './cartRoutes.js';
import promoRoutes from './promoRoutes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/contact', contactRoutes);
router.use('/products', productRoutes);
router.use('/cart', cartRoutes);
router.use('/promo', promoRoutes);

export default router;
