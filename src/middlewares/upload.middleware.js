import multer from "multer";
import path from "path";
import { promises as fsPromises } from "fs";

// Ensure upload directory exists
const ensureUploadsDir = async () => {
  const uploadsDir = path.join(process.cwd(), "src/uploads");
  try {
    await fsPromises.access(uploadsDir);
  } catch {
    await fsPromises.mkdir(uploadsDir, { recursive: true });
    console.log(`✅ Created uploads directory: ${uploadsDir}`);
  }
  return uploadsDir;
};

// Initialize storage after ensuring directory exists
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadsDir = await ensureUploadsDir();
      cb(null, uploadsDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const extension = path.extname(file.originalname);
    cb(null, `${uniqueName}${extension}`);
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [".csv", ".xlsx", ".xls", ".txt"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported file type. Allowed: ${allowedExtensions.join(", ")}`
        )
      );
    }
  },
});
