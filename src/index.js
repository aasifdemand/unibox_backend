import express from 'express';

import dotenv from 'dotenv';
import sequelize from './config/db.js';
import authRoutes from './routes/auth.route.js';
import userRoutes from './routes/user.routes.js';
import "./models/user.model.js"
import errorHandler from './middlewares/error.middleware.js';
import { responseMiddleware } from './middlewares/response.middleware.js';

dotenv.config();

const app = express();

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

try {
  await sequelize.authenticate();
  console.log("PostgreSQL connected");

  await sequelize.sync({alter:true}); // ⚠️ use migrations in real production
  console.log("Models synced");
} catch (error) {
  console.error("DB connection failed:", error);
}

app.use(responseMiddleware)
// routes

app.use('/api/v1/auth',authRoutes )
app.use('/api/v1/users',userRoutes)



app.use(errorHandler);


app.listen(process.env.PORT, () => {
    console.log(`API server is running on port ${process.env.PORT}❤️‍🔥`);
})