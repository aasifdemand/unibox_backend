import swaggerJSDoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Unibox API - Email Campaign Application",
      version: "1.0.0",
      description: "Backend API documentation for Unibox-Email Campaign application",
    },
    servers: [
      {
        url: "http://localhost:8080",
        description: "Development server",
      },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "access_token",
        },
      },
      schemas: {
        SuccessResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Success" },
            data: { type: "object" },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "Error message" },
          },
        },
      },
    },

    // 🔐 OPTIONAL: apply cookie auth globally
    security: [
      {
        cookieAuth: [],
      },
    ],
  },

  apis: ["./src/routes/*.js"],
};

export const swaggerSpec = swaggerJSDoc(options);
