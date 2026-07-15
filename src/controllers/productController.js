import prisma from '../config/db.js';
import { generateUniqueSlug } from '../utils/slug.js';
import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import { filterableFields } from '../config/filtersConfig.js';

/**
 * Helper to clean up files
 */
const cleanFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Error deleting temp file:', err);
    }
  }
};
/**
 * Helper to dynamically resolve (and create if missing) category, subcategory, and screenType relations
 */
const resolveProductRelations = async (data) => {
  const resolved = { ...data };

  // Category (productFamily)
  if (data.productFamily) {
    const name = data.productFamily.trim();
    let cat = await prisma.category.findUnique({ where: { name } });
    if (!cat) {
      cat = await prisma.category.create({ data: { name } });
    }
    resolved.categoryId = cat.id;
  }

  // Subcategory (use)
  if (data.use && resolved.categoryId) {
    const name = data.use.trim();
    let sub = await prisma.subcategory.findUnique({
      where: {
        name_categoryId: {
          name,
          categoryId: resolved.categoryId
        }
      }
    });
    if (!sub) {
      sub = await prisma.subcategory.create({
        data: {
          name,
          categoryId: resolved.categoryId
        }
      });
    }
    resolved.subcategoryId = sub.id;
  }

  // ScreenType (screenType)
  if (data.screenType) {
    const name = data.screenType.trim();
    let st = await prisma.screenType.findUnique({ where: { name } });
    if (!st) {
      st = await prisma.screenType.create({ data: { name } });
    }
    resolved.screenTypeId = st.id;
  }

  return resolved;
};

/**
 * Get all products (paginated, with search & filters)
 */
export const getProducts = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const search = req.query.search || '';
    const sort = req.query.sort || 'recommended';

    const skip = (page - 1) * limit;

    // Define where conditions
    const where = {};

    // Helper to add multi-select "in" condition
    const addMultiSelectFilter = (queryParam, dbField) => {
      const val = req.query[queryParam];
      if (val) {
        const items = val.split(',').map(v => v.trim()).filter(Boolean);
        if (items.length > 0) {
          where[dbField] = { in: items };
        }
      }
    };

    // Add all filters
    addMultiSelectFilter('category', 'productFamily'); // maps category to productFamily
    addMultiSelectFilter('productFamily', 'productFamily'); // support direct parameter
    addMultiSelectFilter('use', 'use');
    addMultiSelectFilter('screenType', 'screenType');
    addMultiSelectFilter('size', 'size');
    addMultiSelectFilter('brightness', 'brightness');
    addMultiSelectFilter('pixelPitch', 'pixelPitch');
    addMultiSelectFilter('indoorOutdoor', 'indoorOutdoor');
    addMultiSelectFilter('mount', 'mount');
    addMultiSelectFilter('operatingSystem', 'operatingSystem');
    addMultiSelectFilter('brand', 'ocBrand');
    addMultiSelectFilter('manufacturer', 'supplier');

    // Filter by price range (GBP)
    // Strategy: COALESCE across onlinePrice, priceGbp, and CAST(landedCostGbp AS DECIMAL)
    // We use $queryRaw to get matching IDs via MySQL CASE expression, then filter by those IDs.
    const minPrice = parseFloat(req.query.minPrice);
    const maxPrice = parseFloat(req.query.maxPrice);

    if (!isNaN(minPrice) || !isNaN(maxPrice)) {
      // Use raw SQL to COALESCE across all three price columns including the string landedCostGbp.
      // MySQL: CAST(REGEXP_REPLACE(landed_cost_gbp, '[^0-9.]', '') AS DECIMAL(10,2))
      // Effective price = COALESCE(online_price, price_gbp, parsed_landed_cost_gbp)
      let rawSql, rawParams;
      if (!isNaN(minPrice) && !isNaN(maxPrice)) {
        rawSql = `
          SELECT id FROM products
          WHERE COALESCE(
            online_price,
            price_gbp,
            CAST(REGEXP_REPLACE(COALESCE(landed_cost_gbp, ''), '[^0-9.]', '') AS DECIMAL(10,2))
          ) BETWEEN ? AND ?
        `;
        rawParams = [minPrice, maxPrice];
      } else if (!isNaN(minPrice)) {
        rawSql = `
          SELECT id FROM products
          WHERE COALESCE(
            online_price,
            price_gbp,
            CAST(REGEXP_REPLACE(COALESCE(landed_cost_gbp, ''), '[^0-9.]', '') AS DECIMAL(10,2))
          ) >= ?
        `;
        rawParams = [minPrice];
      } else {
        rawSql = `
          SELECT id FROM products
          WHERE COALESCE(
            online_price,
            price_gbp,
            CAST(REGEXP_REPLACE(COALESCE(landed_cost_gbp, ''), '[^0-9.]', '') AS DECIMAL(10,2))
          ) <= ?
        `;
        rawParams = [maxPrice];
      }
      const matchingRows = await prisma.$queryRawUnsafe(rawSql, ...rawParams);
      const matchingIds = matchingRows.map(r => r.id);
      where.id = { in: matchingIds.length > 0 ? matchingIds : [-1] };
    }


    if (search) {
      const searchCond = { contains: search };
      const searchFields = [
        { model: searchCond },
        { productName: searchCond },
        { productFamily: searchCond },
        { use: searchCond },
        { productSummary: searchCond },
        { longDescription: searchCond }
      ];

      if (where.OR) {
        // If OR is already used (e.g. for price range), we AND the search condition with it
        where.AND = [
          { OR: where.OR },
          { OR: searchFields }
        ];
        delete where.OR;
      } else {
        where.OR = searchFields;
      }
    }

    // ── In-memory sort + paginate ─────────────────────────────────────────────
    // Prisma cannot ORDER BY a COALESCE across onlinePrice / priceGbp / landedCostGbp.
    // For the current dataset size (hundreds of products) fetching all matching rows,
    // sorting in Node.js, then slicing is fast and 100% correct.
    // For name-asc and recommended we can still use DB ordering via Prisma, which
    // is fine since they don't rely on computed values.

    let allFiltered;
    const total = await prisma.product.count({ where });

    if (sort === 'price-low' || sort === 'price-high') {
      // Fetch all matching rows for in-memory price sort
      allFiltered = await prisma.product.findMany({ where });

      // Parse landedCostGbp safely
      const parseLandedCost = (val) => {
        if (!val) return 0;
        const cleaned = String(val).replace(/[^0-9.]/g, '');
        const num = parseFloat(cleaned);
        return isNaN(num) ? 0 : num;
      };

      // Effective price = onlinePrice (for online products) OR priceGbp (for quote products)
      const effectivePrice = (p) => {
        const parsedLanded = parseLandedCost(p.landedCostGbp);
        if (p.purchaseType === 'online') {
          return p.onlinePrice ?? p.priceGbp ?? parsedLanded ?? 0;
        }
        return p.priceGbp ?? p.onlinePrice ?? parsedLanded ?? 0;
      };

      if (sort === 'price-low') {
        allFiltered.sort((a, b) => effectivePrice(a) - effectivePrice(b));
      } else {
        allFiltered.sort((a, b) => effectivePrice(b) - effectivePrice(a));
      }

      // Slice for current page
      const products = allFiltered.slice(skip, skip + limit);

      return res.status(200).json({
        success: true,
        data: products,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit)
        }
      });
    }

    // Default: name-asc or recommended — use DB ordering via Prisma
    let orderBy = { createdAt: 'desc' };
    if (sort === 'name-asc') orderBy = { productName: 'asc' };

    const products = await prisma.product.findMany({
      where,
      skip,
      take: limit,
      orderBy,
    });

    res.status(200).json({
      success: true,
      data: products,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get distinct filterable values for properties
 * Also returns meta.categorySubcategoryMap for hierarchical filter UX
 */
export const getFilters = async (req, res, next) => {
  try {
    const filters = {};

    // --- Categories from Category table (with their linked subcategories) ---
    const categoriesWithSubs = await prisma.category.findMany({
      where: { status: 'Active' },
      orderBy: { name: 'asc' },
      include: {
        subcategories: {
          where: { status: 'Active' },
          select: { name: true },
          orderBy: { name: 'asc' }
        }
      }
    });
    filters.productFamily = categoriesWithSubs.map(c => c.name.trim()).filter(Boolean);

    // Build category → subcategory mapping for hierarchical filter UX
    const categorySubcategoryMap = {};
    for (const cat of categoriesWithSubs) {
      categorySubcategoryMap[cat.name.trim()] = cat.subcategories
        .map(s => s.name.trim())
        .filter(Boolean);
    }

    // --- All Subcategories (Use Cases) from Subcategory table ---
    const subcategories = await prisma.subcategory.findMany({
      where: { status: 'Active' },
      select: { name: true },
      orderBy: { name: 'asc' }
    });
    filters.use = [...new Set(subcategories.map(s => s.name.trim()).filter(Boolean))];

    // --- Screen Types from ScreenType table ---
    const screenTypes = await prisma.screenType.findMany({
      where: { status: 'Active' },
      select: { name: true },
      orderBy: { name: 'asc' }
    });
    filters.screenType = screenTypes.map(st => st.name.trim()).filter(Boolean);

    // --- Remaining fields from Product distinct values ---
    const remainingFields = [
      { field: 'size' },
      { field: 'brightness' },
      { field: 'pixelPitch' },
      { field: 'indoorOutdoor' },
      { field: 'mount' },
      { field: 'operatingSystem' }
    ];

    for (const item of remainingFields) {
      const distinctValues = await prisma.product.findMany({
        select: { [item.field]: true },
        distinct: [item.field],
        where: { [item.field]: { not: null } }
      });
      const values = distinctValues
        .map(v => v[item.field]?.trim())
        .filter(Boolean);
      filters[item.field] = [...new Set(values)].sort();
    }

    res.status(200).json({
      success: true,
      data: filters,
      meta: { categorySubcategoryMap }
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Get single product by ID or Slug
 */
export const getProductById = async (req, res, next) => {
  try {
    const { idOrSlug } = req.params;

    // Try finding by id or slug
    let product;
    if (!isNaN(idOrSlug)) {
      product = await prisma.product.findUnique({
        where: { id: parseInt(idOrSlug, 10) }
      });
    }

    if (!product) {
      product = await prisma.product.findUnique({
        where: { slug: idOrSlug }
      });
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      data: product
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Helper to parse a GBP string like "£363" or "363.50" into a Float
 */
const parsePriceGbp = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
};

/**
 * Backfill priceGbp for all products that have landedCostGbp but missing priceGbp.
 * Call POST /products/backfill-prices once to fix existing data.
 */
export const backfillPriceGbp = async (req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        priceGbp: null,
        landedCostGbp: { not: null }
      },
      select: { id: true, landedCostGbp: true }
    });

    let updated = 0;
    for (const p of products) {
      const parsed = parsePriceGbp(p.landedCostGbp);
      if (parsed !== null) {
        await prisma.product.update({
          where: { id: p.id },
          data: { priceGbp: parsed }
        });
        updated++;
      }
    }

    res.status(200).json({
      success: true,
      message: `Backfilled priceGbp for ${updated} products (out of ${products.length} checked).`,
      updated
    });
  } catch (error) {
    next(error);
  }
};



export const createProduct = async (req, res, next) => {
  try {
    const productData = req.body;

    if (!productData.model) {
      return res.status(400).json({
        success: false,
        message: 'Model code is required'
      });
    }

    // Generate unique slug
    const slug = await generateUniqueSlug(productData.model, productData.productFamily);

    // Resolve category, subcategory, screenType relations
    const resolvedData = await resolveProductRelations(productData);

    // Auto-populate priceGbp from landedCostGbp if not explicitly set
    if (!resolvedData.priceGbp && resolvedData.landedCostGbp) {
      resolvedData.priceGbp = parsePriceGbp(resolvedData.landedCostGbp);
    }

    const product = await prisma.product.create({
      data: {
        ...resolvedData,
        slug,
        picture: productData.picture || [],
        quotes: productData.quotes || []
      }
    });

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update an existing product
 */
export const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const existingProduct = await prisma.product.findUnique({
      where: { id: parseInt(id, 10) }
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Generate new slug if model or productFamily changed
    let slug = existingProduct.slug;
    if (
      (updateData.model && updateData.model !== existingProduct.model) ||
      (updateData.productFamily && updateData.productFamily !== existingProduct.productFamily)
    ) {
      slug = await generateUniqueSlug(
        updateData.model || existingProduct.model,
        updateData.productFamily || existingProduct.productFamily,
        existingProduct.id
      );
    }

    // Resolve category, subcategory, screenType relations
    const resolvedData = await resolveProductRelations(updateData);

    // Auto-populate priceGbp from landedCostGbp if not explicitly set
    if (!resolvedData.priceGbp && resolvedData.landedCostGbp) {
      resolvedData.priceGbp = parsePriceGbp(resolvedData.landedCostGbp);
    }

    const updated = await prisma.product.update({
      where: { id: parseInt(id, 10) },
      data: {
        ...resolvedData,
        slug,
        picture: updateData.picture !== undefined ? updateData.picture : existingProduct.picture,
        quotes: updateData.quotes !== undefined ? updateData.quotes : existingProduct.quotes
      }
    });

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: updated
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a product
 */
export const deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;

    const existingProduct = await prisma.product.findUnique({
      where: { id: parseInt(id, 10) }
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    await prisma.product.delete({
      where: { id: parseInt(id, 10) }
    });

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Upload multiple images
 */
export const uploadImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No image files uploaded'
      });
    }

    const filePaths = req.files.map(file => `/uploads/${file.filename}`);

    res.status(200).json({
      success: true,
      message: 'Images uploaded successfully',
      data: filePaths
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Bulk Import from CSV/Excel
 */
export const bulkImport = async (req, res, next) => {
  let filePath = '';
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please upload a CSV or Excel (.xlsx) file.'
      });
    }

    filePath = req.file.path;
    const clearDb = req.body.clear === 'true' || req.query.clear === 'true';

    // Read the sheet using xlsx
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert sheet to raw array of arrays
    const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rawRows.length < 4) {
      return res.status(400).json({
        success: false,
        message: 'The uploaded file does not contain enough rows of product data.'
      });
    }

    // Row 1 (index 0) has margins/quote column parameters
    // Row 3 (index 2) has main column headers
    const row1 = rawRows[0];
    const headers = rawRows[2];

    const productsToCreate = [];

    // Fetch all existing categories, subcategories, screenTypes to cache
    const existingCategories = await prisma.category.findMany({});
    const categoryMap = new Map(existingCategories.map(c => [c.name.toLowerCase().trim(), c.id]));

    const existingSubcategories = await prisma.subcategory.findMany({});
    const subcategoryMap = new Map(existingSubcategories.map(s => [`${s.name.toLowerCase().trim()}__${s.categoryId}`, s.id]));

    const existingScreenTypes = await prisma.screenType.findMany({});
    const screenTypeMap = new Map(existingScreenTypes.map(st => [st.name.toLowerCase().trim(), st.id]));

    // Parse product data starting from Row 4 (index 3)
    for (let i = 3; i < rawRows.length; i++) {
      const row = rawRows[i];
      // Skip empty rows
      if (row.length === 0 || !row[3]) continue;

      const model = String(row[3]).trim();
      const productFamily = String(row[1]).trim();
      const use = String(row[2]).trim();

      // Basic fields
      const dateAdded = row[0] ? String(row[0]).trim() : '';
      const productName = row[4] ? String(row[4]).trim() : '';
      const skuNumber = row[5] ? String(row[5]).trim() : '';
      const size = row[6] ? String(row[6]).trim() : '';
      const rawPicture = row[7] ? String(row[7]).trim() : '';
      
      // Setup picture array: Ignore excel garbage values like #VALUE! or Picture
      let picture = [];
      if (rawPicture && rawPicture !== '#VALUE!' && rawPicture.toLowerCase() !== 'picture') {
        picture = rawPicture.split(',').map(p => p.trim()).filter(Boolean);
      }

      const productSummary = row[8] ? String(row[8]).trim() : '';
      const longDescription = row[9] ? String(row[9]).trim() : '';
      const supplierUrl = row[10] ? String(row[10]).trim() : '';
      const pixelPitch = row[11] ? String(row[11]).trim() : '';
      const screenType = row[12] ? String(row[12]).trim() : '';
      const supplier = row[13] ? String(row[13]).trim() : '';
      const ocBrand = row[14] ? String(row[14]).trim() : '';
      const mount = row[15] ? String(row[15]).trim() : '';
      const sides = row[16] ? String(row[16]).trim() : '';
      const indoorOutdoor = row[17] ? String(row[17]).trim() : '';
      const outdoorRating = row[18] ? String(row[18]).trim() : '';
      const operatingSystem = row[19] ? String(row[19]).trim() : '';
      const processor = row[20] ? String(row[20]).trim() : '';
      const ram = row[21] ? String(row[21]).trim() : '';
      const rom = row[22] ? String(row[22]).trim() : '';
      const brightness = row[23] ? String(row[23]).trim() : '';
      const cabinetSize = row[24] ? String(row[24]).trim() : '';
      const cabinetQty = row[25] ? String(row[25]).trim() : '';
      const cabinetWeight = row[26] ? String(row[26]).trim() : '';
      const screenDimension = row[27] ? String(row[27]).trim() : '';
      const outerSize = row[28] ? String(row[28]).trim() : '';
      const leadTime = row[29] ? String(row[29]).trim() : '';
      const warranty = row[30] ? String(row[30]).trim() : '';
      const moqs = row[31] ? String(row[31]).trim() : '';
      const touch = row[32] ? String(row[32]).trim() : '';
      const camera = row[33] ? String(row[33]).trim() : '';
      const priceUsd = row[34] ? String(row[34]).trim() : '';
      const amountEwx = row[35] ? String(row[35]).trim() : '';
      const shipping = row[36] ? String(row[36]).trim() : '';
      const landedCostUsd = row[37] ? String(row[37]).trim() : '';
      const landedCostGbp = row[38] ? String(row[38]).trim() : '';

      // Margin and Quotes matching (Col 39 to 62)
      const quotes = [];
      for (let colIdx = 39; colIdx <= 62; colIdx++) {
        if (colIdx % 2 === 1) { // odd column indices are margins
          const margin = String(row1[colIdx] || headers[colIdx]).trim();
          const quoteVal = row[colIdx + 1] ? String(row[colIdx + 1]).trim() : '';
          if (margin && quoteVal) {
            quotes.push({ margin, quote: quoteVal });
          }
        }
      }

      // Resolve category relation
      let categoryId = null;
      if (productFamily) {
        const catKey = productFamily.toLowerCase().trim();
        if (categoryMap.has(catKey)) {
          categoryId = categoryMap.get(catKey);
        } else {
          const newCat = await prisma.category.create({ data: { name: productFamily } });
          categoryId = newCat.id;
          categoryMap.set(catKey, categoryId);
        }
      }

      // Resolve subcategory relation
      let subcategoryId = null;
      if (use && categoryId) {
        const subKey = `${use.toLowerCase().trim()}__${categoryId}`;
        if (subcategoryMap.has(subKey)) {
          subcategoryId = subcategoryMap.get(subKey);
        } else {
          const newSub = await prisma.subcategory.create({
            data: {
              name: use,
              categoryId
            }
          });
          subcategoryId = newSub.id;
          subcategoryMap.set(subKey, subcategoryId);
        }
      }

      // Resolve screenType relation
      let screenTypeId = null;
      if (screenType) {
        const stKey = screenType.toLowerCase().trim();
        if (screenTypeMap.has(stKey)) {
          screenTypeId = screenTypeMap.get(stKey);
        } else {
          const newSt = await prisma.screenType.create({ data: { name: screenType } });
          screenTypeId = newSt.id;
          screenTypeMap.set(stKey, screenTypeId);
        }
      }

      // Auto-populate priceGbp from landedCostGbp for numeric filtering
      const parsedPriceGbp = parsePriceGbp(landedCostGbp);

      productsToCreate.push({
        dateAdded,
        productFamily,
        use,
        model,
        productName,
        skuNumber,
        size,
        picture,
        productSummary,
        longDescription,
        supplierUrl,
        pixelPitch,
        screenType,
        supplier,
        ocBrand,
        mount,
        sides,
        indoorOutdoor,
        outdoorRating,
        operatingSystem,
        processor,
        ram,
        rom,
        brightness,
        cabinetSize,
        cabinetQty,
        cabinetWeight,
        screenDimension,
        outerSize,
        leadTime,
        warranty,
        moqs,
        touch,
        camera,
        priceUsd,
        amountEwx,
        shipping,
        landedCostUsd,
        landedCostGbp,
        priceGbp: parsedPriceGbp,  // numeric copy for price range filtering
        quotes,
        categoryId,
        subcategoryId,
        screenTypeId
      });
    }

    if (productsToCreate.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid products found to import.'
      });
    }

    // Pre-generate unique slugs BEFORE starting the transaction.
    // We track slugs used in this batch in-memory to avoid collisions between rows.
    const seenSlugs = new Set();

    for (const prod of productsToCreate) {
      const base = `${prod.model || ''} ${prod.productFamily || ''}`.trim() || 'product';
      let slug = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '') || 'product';

      let uniqueSlug = slug;
      let counter = 1;

      // Check both DB and the current batch for uniqueness
      while (true) {
        const dbExists = await prisma.product.findFirst({ where: { slug: uniqueSlug } });
        if (!dbExists && !seenSlugs.has(uniqueSlug)) {
          break;
        }
        uniqueSlug = `${slug}-${counter}`;
        counter++;
      }

      seenSlugs.add(uniqueSlug);
      prod.slug = uniqueSlug;
    }

    // Process DB changes
    if (clearDb) {
      await prisma.product.deleteMany({});
    }

    // Insert in batches of 50 to avoid timeouts
    const BATCH_SIZE = 50;
    for (let i = 0; i < productsToCreate.length; i += BATCH_SIZE) {
      const batch = productsToCreate.slice(i, i + BATCH_SIZE);
      await prisma.product.createMany({
        data: batch,
        skipDuplicates: true
      });
    }

    res.status(200).json({
      success: true,
      message: `Successfully imported ${productsToCreate.length} products.`,
      count: productsToCreate.length
    });
  } catch (error) {
    next(error);
  } finally {
    cleanFile(filePath);
  }
};

/**
 * Bulk Export to Excel (.xlsx)
 */
export const bulkExport = async (req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' }
    });

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No products in database to export.'
      });
    }

    // Build the worksheet rows
    const dataRows = [];

    // Header 1: Margins row
    const row1 = new Array(67).fill('');
    row1[0] = 'Ilaan Product Catalogue';
    // Repopulate headers on first row for quotes
    // We can define static margins like in the sheet
    const defaultMargins = [
      { col: 39, val: '50.00%' },
      { col: 41, val: '10.00%' },
      { col: 43, val: '20.00%' },
      { col: 45, val: '30.00%' },
      { col: 47, val: '40.00%' },
      { col: 49, val: '50.00%' },
      { col: 51, val: '60.00%' },
      { col: 53, val: '70.00%' },
      { col: 55, val: '80.00%' },
      { col: 57, val: '90.00%' },
      { col: 59, val: '100.00%' },
      { col: 61, val: '100.00%' }
    ];
    defaultMargins.forEach(dm => {
      row1[dm.col] = dm.val;
    });
    dataRows.push(row1);

    // Header 2: Empty spacer
    dataRows.push(new Array(67).fill(''));

    // Header 3: Columns row
    const row3 = [
      'Date Added', 'Product Family', 'Use', 'Model', 'Product Name', 'SKU Number', 'Size', 'Picture',
      'Product Summary', 'Long Description', 'Supplier URL', 'Pixel Pitch / Resolution', 'Screen Type',
      'Supplier', 'OC Brand', 'Mount', 'Sides', 'Indoor/Outdoor', 'Outdoor Rating', 'Operating System',
      'Processor', 'RAM', 'ROM', 'Brightness (nits)', 'Cabinet Size (L*H)', 'Cabinet Qty', 'Cabinet Weight',
      'Screen Dimension', 'Outer Size', 'Lead Time', 'Warranty', 'MoQs', 'Touch', 'Camera', 'Price (USD/pcs)',
      'Amount (EWX)', 'Shipping', 'Landed Cost (USD)', 'Landed Cost (GBP)'
    ];

    // Padding headers up to Col 62 for Margins/Quotes
    for (let colIdx = 39; colIdx <= 62; colIdx++) {
      if (colIdx % 2 === 1) {
        row3[colIdx] = 'Margin';
      } else {
        row3[colIdx] = 'Quote (ex. VAT)';
      }
    }
    dataRows.push(row3);

    // Products data rows
    products.forEach(p => {
      const row = new Array(67).fill('');
      row[0] = p.dateAdded || '';
      row[1] = p.productFamily || '';
      row[2] = p.use || '';
      row[3] = p.model || '';
      row[4] = p.productName || '';
      row[5] = p.skuNumber || '';
      row[6] = p.size || '';
      
      // Picture array to comma-separated string
      const pics = Array.isArray(p.picture) ? p.picture : JSON.parse(JSON.stringify(p.picture || []));
      row[7] = pics.join(', ');

      row[8] = p.productSummary || '';
      row[9] = p.longDescription || '';
      row[10] = p.supplierUrl || '';
      row[11] = p.pixelPitch || '';
      row[12] = p.screenType || '';
      row[13] = p.supplier || '';
      row[14] = p.ocBrand || '';
      row[15] = p.mount || '';
      row[16] = p.sides || '';
      row[17] = p.indoorOutdoor || '';
      row[18] = p.outdoorRating || '';
      row[19] = p.operatingSystem || '';
      row[20] = p.processor || '';
      row[21] = p.ram || '';
      row[22] = p.rom || '';
      row[23] = p.brightness || '';
      row[24] = p.cabinetSize || '';
      row[25] = p.cabinetQty || '';
      row[26] = p.cabinetWeight || '';
      row[27] = p.screenDimension || '';
      row[28] = p.outerSize || '';
      row[29] = p.leadTime || '';
      row[30] = p.warranty || '';
      row[31] = p.moqs || '';
      row[32] = p.touch || '';
      row[33] = p.camera || '';
      row[34] = p.priceUsd || '';
      row[35] = p.amountEwx || '';
      row[36] = p.shipping || '';
      row[37] = p.landedCostUsd || '';
      row[38] = p.landedCostGbp || '';

      // Populate quotes
      const quotes = Array.isArray(p.quotes) ? p.quotes : JSON.parse(JSON.stringify(p.quotes || []));
      defaultMargins.forEach(dm => {
        const foundQuote = quotes.find(q => q.margin === dm.val);
        row[dm.col] = dm.val;
        row[dm.col + 1] = foundQuote ? foundQuote.quote : '';
      });

      dataRows.push(row);
    });

    // Create Excel Workbook
    const wb = xlsx.book_new();
    const ws = xlsx.utils.aoa_to_sheet(dataRows);
    xlsx.book_append_sheet(wb, ws, 'Products');

    // Write to buffer
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ilaan_products_export.xlsx');
    res.status(200).send(buffer);
  } catch (error) {
    next(error);
  }
};

/**
 * Get dynamic categories, subcategories, and screen types metadata
 */
export const getMetadata = async (req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      include: {
        _count: { select: { products: true } }
      }
    });

    const subcategories = await prisma.subcategory.findMany({
      include: {
        category: true,
        _count: { select: { products: true } }
      }
    });

    const screenTypes = await prisma.screenType.findMany({
      include: {
        _count: { select: { products: true } }
      }
    });

    res.status(200).json({
      success: true,
      data: {
        categories: categories.map(c => ({ id: c.id, name: c.name, description: c.description, status: c.status, count: c._count.products })),
        subcategories: subcategories.map(s => ({ id: s.id, name: s.name, category: s.category.name, categoryId: s.categoryId, description: s.description, status: s.status, count: s._count.products })),
        screenTypes: screenTypes.map(st => ({ id: st.id, name: st.name, description: st.description, status: st.status, count: st._count.products }))
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Categories CRUD
 */
export const getCategories = async (req, res, next) => {
  try {
    const list = await prisma.category.findMany({
      include: {
        _count: { select: { products: true } },
        subcategories: true
      },
      orderBy: { name: 'asc' }
    });
    res.status(200).json({
      success: true,
      data: list.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        status: c.status,
        count: c._count.products,
        subcategories: c.subcategories.map(s => s.name)
      }))
    });
  } catch (error) {
    next(error);
  }
};

export const createCategory = async (req, res, next) => {
  try {
    const { name, description, status } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Category name is required' });
    }

    const existing = await prisma.category.findUnique({ where: { name: name.trim() } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Category already exists' });
    }

    const created = await prisma.category.create({
      data: {
        name: name.trim(),
        description: description || '',
        status: status || 'Active'
      }
    });

    res.status(201).json({ success: true, message: 'Category created successfully', data: created });
  } catch (error) {
    next(error);
  }
};

export const updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, status } = req.body;

    const existing = await prisma.category.findUnique({ where: { id: parseInt(id, 10) } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    if (name && name.trim() !== existing.name) {
      const nameExists = await prisma.category.findUnique({ where: { name: name.trim() } });
      if (nameExists) {
        return res.status(400).json({ success: false, message: 'Category with this name already exists' });
      }
    }

    const updated = await prisma.category.update({
      where: { id: parseInt(id, 10) },
      data: {
        name: name ? name.trim() : existing.name,
        description: description !== undefined ? description : existing.description,
        status: status !== undefined ? status : existing.status
      }
    });

    if (name && name.trim() !== existing.name) {
      await prisma.product.updateMany({
        where: { categoryId: parseInt(id, 10) },
        data: { productFamily: name.trim() }
      });
    }

    res.status(200).json({ success: true, message: 'Category updated successfully', data: updated });
  } catch (error) {
    next(error);
  }
};

export const deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.category.findUnique({ where: { id: parseInt(id, 10) } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    await prisma.product.updateMany({
      where: { categoryId: parseInt(id, 10) },
      data: { productFamily: null }
    });

    await prisma.category.delete({ where: { id: parseInt(id, 10) } });
    res.status(200).json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * Subcategories CRUD
 */
export const getSubcategories = async (req, res, next) => {
  try {
    const list = await prisma.subcategory.findMany({
      include: {
        category: true,
        _count: { select: { products: true } }
      },
      orderBy: { name: 'asc' }
    });
    res.status(200).json({
      success: true,
      data: list.map(s => ({
        id: s.id,
        name: s.name,
        category: s.category.name,
        categoryId: s.categoryId,
        description: s.description,
        status: s.status,
        count: s._count.products
      }))
    });
  } catch (error) {
    next(error);
  }
};

export const createSubcategory = async (req, res, next) => {
  try {
    const { name, categoryId, categoryName, description, status } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Subcategory name is required' });
    }

    let finalCategoryId = categoryId;
    if (!finalCategoryId && categoryName) {
      let cat = await prisma.category.findUnique({ where: { name: categoryName.trim() } });
      if (!cat) {
        cat = await prisma.category.create({ data: { name: categoryName.trim() } });
      }
      finalCategoryId = cat.id;
    }

    if (!finalCategoryId) {
      return res.status(400).json({ success: false, message: 'Category ID or Name is required' });
    }

    const existing = await prisma.subcategory.findUnique({
      where: {
        name_categoryId: {
          name: name.trim(),
          categoryId: parseInt(finalCategoryId, 10)
        }
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Subcategory already exists under this Category' });
    }

    const created = await prisma.subcategory.create({
      data: {
        name: name.trim(),
        categoryId: parseInt(finalCategoryId, 10),
        description: description || '',
        status: status || 'Active'
      }
    });

    res.status(201).json({ success: true, message: 'Subcategory created successfully', data: created });
  } catch (error) {
    next(error);
  }
};

export const updateSubcategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, categoryId, description, status } = req.body;

    const existing = await prisma.subcategory.findUnique({ where: { id: parseInt(id, 10) } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Subcategory not found' });
    }

    const finalName = name ? name.trim() : existing.name;
    const finalCategoryId = categoryId ? parseInt(categoryId, 10) : existing.categoryId;

    if (name || categoryId) {
      const nameExists = await prisma.subcategory.findUnique({
        where: {
          name_categoryId: {
            name: finalName,
            categoryId: finalCategoryId
          }
        }
      });
      if (nameExists && nameExists.id !== existing.id) {
        return res.status(400).json({ success: false, message: 'Subcategory name already exists under this Category' });
      }
    }

    const updated = await prisma.subcategory.update({
      where: { id: parseInt(id, 10) },
      data: {
        name: finalName,
        categoryId: finalCategoryId,
        description: description !== undefined ? description : existing.description,
        status: status !== undefined ? status : existing.status
      }
    });

    if (finalName !== existing.name) {
      await prisma.product.updateMany({
        where: { subcategoryId: parseInt(id, 10) },
        data: { use: finalName }
      });
    }

    res.status(200).json({ success: true, message: 'Subcategory updated successfully', data: updated });
  } catch (error) {
    next(error);
  }
};

export const deleteSubcategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.subcategory.findUnique({ where: { id: parseInt(id, 10) } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Subcategory not found' });
    }

    await prisma.product.updateMany({
      where: { subcategoryId: parseInt(id, 10) },
      data: { use: null }
    });

    await prisma.subcategory.delete({ where: { id: parseInt(id, 10) } });
    res.status(200).json({ success: true, message: 'Subcategory deleted successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * ScreenTypes CRUD
 */
export const getScreenTypes = async (req, res, next) => {
  try {
    const list = await prisma.screenType.findMany({
      include: {
        _count: { select: { products: true } }
      },
      orderBy: { name: 'asc' }
    });
    res.status(200).json({
      success: true,
      data: list.map(st => ({
        id: st.id,
        name: st.name,
        description: st.description,
        status: st.status,
        count: st._count.products
      }))
    });
  } catch (error) {
    next(error);
  }
};

export const createScreenType = async (req, res, next) => {
  try {
    const { name, description, status } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Screen type name is required' });
    }

    const existing = await prisma.screenType.findUnique({ where: { name: name.trim() } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Screen type already exists' });
    }

    const created = await prisma.screenType.create({
      data: {
        name: name.trim(),
        description: description || '',
        status: status || 'Active'
      }
    });

    res.status(201).json({ success: true, message: 'Screen type created successfully', data: created });
  } catch (error) {
    next(error);
  }
};

export const updateScreenType = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, status } = req.body;

    const existing = await prisma.screenType.findUnique({ where: { id: parseInt(id, 10) } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Screen type not found' });
    }

    if (name && name.trim() !== existing.name) {
      const nameExists = await prisma.screenType.findUnique({ where: { name: name.trim() } });
      if (nameExists) {
        return res.status(400).json({ success: false, message: 'Screen type with this name already exists' });
      }
    }

    const updated = await prisma.screenType.update({
      where: { id: parseInt(id, 10) },
      data: {
        name: name ? name.trim() : existing.name,
        description: description !== undefined ? description : existing.description,
        status: status !== undefined ? status : existing.status
      }
    });

    if (name && name.trim() !== existing.name) {
      await prisma.product.updateMany({
        where: { screenTypeId: parseInt(id, 10) },
        data: { screenType: name.trim() }
      });
    }

    res.status(200).json({ success: true, message: 'Screen type updated successfully', data: updated });
  } catch (error) {
    next(error);
  }
};

export const deleteScreenType = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.screenType.findUnique({ where: { id: parseInt(id, 10) } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Screen type not found' });
    }

    await prisma.product.updateMany({
      where: { screenTypeId: parseInt(id, 10) },
      data: { screenType: null }
    });

    await prisma.screenType.delete({ where: { id: parseInt(id, 10) } });
    res.status(200).json({ success: true, message: 'Screen type deleted successfully' });
  } catch (error) {
    next(error);
  }
};



