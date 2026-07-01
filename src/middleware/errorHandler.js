/**
 * Global Error Handler Middleware
 * Catches all unhandled errors from route handlers.
 */

function errorHandler(err, req, res, next) {
  // Log the error server-side
  console.error(`[Error] ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  // CORS rejection (thrown by the cors() origin callback in app.js)
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // Meta API errors
  if (err.isMetaError) {
    return res.status(502).json({
      error: 'Meta API error',
      message: err.message,
      code: err.code,
    });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation error',
      message: err.message,
    });
  }

  // Default 500
  return res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
}

/**
 * Async route wrapper — catches async errors and passes them to next().
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { errorHandler, asyncHandler };
