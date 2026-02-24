import sequelize from "./src/config/db.js";

(async () => {
  try {
    const [results] = await sequelize.query(`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE table_name IN ('emails', 'bounce_events')
      ORDER BY table_name, column_name
    `);
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
})();
