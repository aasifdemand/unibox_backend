import jwt from "jsonwebtoken";

export function genToken(userId) {
    try {
        return jwt.sign({ id: userId }, process.env.JWT_SECRET, {expiresIn:"7d"});
    } catch (error) {
        throw new Error("Token generation failed",error.message);
    }
}