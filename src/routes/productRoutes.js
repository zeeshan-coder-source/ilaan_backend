import { Router } from 'express';
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  uploadImages,
  bulkImport,
  bulkExport,
  getMetadata,
  getFilters,
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getSubcategories,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
  getScreenTypes,
  createScreenType,
  updateScreenType,
  deleteScreenType,
  backfillPriceGbp
} from '../controllers/productController.js';
import upload from '../middlewares/upload.js';

const router = Router();

// Products search, lisgetProductst, create
router.get('/', getProducts);
router.post('/', createProduct);

// Dynamic filters
router.get('/filters', getFilters);

// Dynamic categories & subcategories metadata
router.get('/metadata', getMetadata);

// Categories CRUD
router.get('/categories', getCategories);
router.post('/categories', createCategory);
router.put('/categories/:id', updateCategory);
router.delete('/categories/:id', deleteCategory);

// Subcategories CRUD
router.get('/subcategories', getSubcategories);
router.post('/subcategories', createSubcategory);
router.put('/subcategories/:id', updateSubcategory);
router.delete('/subcategories/:id', deleteSubcategory);

// ScreenTypes CRUD
router.get('/screentypes', getScreenTypes);
router.post('/screentypes', createScreenType);
router.put('/screentypes/:id', updateScreenType);
router.delete('/screentypes/:id', deleteScreenType);

// Bulk import & export
router.post('/import', upload.single('file'), bulkImport);
router.get('/export', bulkExport);

// Multiple image upload endpoint
router.post('/upload-images', upload.array('images', 10), uploadImages);

// Backfill priceGbp for existing products imported with only landedCostGbp
router.post('/backfill-prices', backfillPriceGbp);

// Get, update, delete single product
router.get('/:idOrSlug', getProductById);
router.put('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;

