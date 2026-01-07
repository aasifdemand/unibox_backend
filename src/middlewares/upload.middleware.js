import multer from "multer";
import path from "path";

const storage = multer.diskStorage({
  destination: "src/uploads/",
  filename: (_, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = [".csv", ".xlsx", ".txt"];
    cb(null, allowed.includes(path.extname(file.originalname)));
  },
});
