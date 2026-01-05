export const responseMiddleware = (req, res, next) => {
  res.ok = ({ message = "Success", data = null }) => {
    res.status(200).json({
      success: true,
      message,
      ...(data && { data }),
    });
  };

  res.created = ({ message = "Created", data = null }) => {
    res.status(201).json({
      success: true,
      message,
      ...(data && { data }),
    });
  };

  next();
};
