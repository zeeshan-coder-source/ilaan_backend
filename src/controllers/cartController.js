import prisma from '../config/db.js';

/**
 * Get or create guest cart and return items
 */
export const getCart = async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    let cart = await prisma.cart.findUnique({
      where: { sessionId },
      include: {
        items: {
          include: {
            product: true
          }
        }
      }
    });

    if (!cart) {
      // Return empty list if cart doesn't exist yet
      return res.status(200).json({
        success: true,
        data: []
      });
    }

    res.status(200).json({
      success: true,
      data: cart.items
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Add an item to the cart
 */
export const addToCart = async (req, res, next) => {
  try {
    const { sessionId, productId, quantity = 1 } = req.body;
    if (!sessionId || !productId) {
      return res.status(400).json({ success: false, message: 'sessionId and productId are required' });
    }

    const prodId = parseInt(productId, 10);

    // Verify product exists
    const product = await prisma.product.findUnique({ where: { id: prodId } });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Get or create cart
    let cart = await prisma.cart.findUnique({ where: { sessionId } });
    if (!cart) {
      cart = await prisma.cart.create({ data: { sessionId } });
    }

    // Add or increment item
    const existingItem = await prisma.cartItem.findUnique({
      where: {
        cartId_productId: {
          cartId: cart.id,
          productId: prodId
        }
      }
    });

    if (existingItem) {
      await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: existingItem.quantity + quantity }
      });
    } else {
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId: prodId,
          quantity
        }
      });
    }

    // Fetch updated cart items
    const items = await prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true }
    });

    res.status(200).json({
      success: true,
      message: 'Item added to cart',
      data: items
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update cart item quantity
 */
export const updateCartItem = async (req, res, next) => {
  try {
    const { sessionId, productId, quantity } = req.body;
    if (!sessionId || !productId || quantity === undefined) {
      return res.status(400).json({ success: false, message: 'sessionId, productId, and quantity are required' });
    }

    const prodId = parseInt(productId, 10);
    const qty = parseInt(quantity, 10);

    const cart = await prisma.cart.findUnique({ where: { sessionId } });
    if (!cart) {
      return res.status(404).json({ success: false, message: 'Cart not found' });
    }

    const item = await prisma.cartItem.findUnique({
      where: {
        cartId_productId: {
          cartId: cart.id,
          productId: prodId
        }
      }
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found in cart' });
    }

    if (qty <= 0) {
      // Remove item if quantity is 0 or less
      await prisma.cartItem.delete({ where: { id: item.id } });
    } else {
      await prisma.cartItem.update({
        where: { id: item.id },
        data: { quantity: qty }
      });
    }

    const items = await prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true }
    });

    res.status(200).json({
      success: true,
      message: 'Cart updated',
      data: items
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Remove an item from the cart
 */
export const removeFromCart = async (req, res, next) => {
  try {
    const { sessionId, productId } = req.body;
    if (!sessionId || !productId) {
      return res.status(400).json({ success: false, message: 'sessionId and productId are required' });
    }

    const prodId = parseInt(productId, 10);

    const cart = await prisma.cart.findUnique({ where: { sessionId } });
    if (!cart) {
      return res.status(404).json({ success: false, message: 'Cart not found' });
    }

    const item = await prisma.cartItem.findUnique({
      where: {
        cartId_productId: {
          cartId: cart.id,
          productId: prodId
        }
      }
    });

    if (item) {
      await prisma.cartItem.delete({ where: { id: item.id } });
    }

    const items = await prisma.cartItem.findMany({
      where: { cartId: cart.id },
      include: { product: true }
    });

    res.status(200).json({
      success: true,
      message: 'Item removed from cart',
      data: items
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Clear the entire cart
 */
export const clearCart = async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const cart = await prisma.cart.findUnique({ where: { sessionId } });
    if (cart) {
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    }

    res.status(200).json({
      success: true,
      message: 'Cart cleared',
      data: []
    });
  } catch (error) {
    next(error);
  }
};
