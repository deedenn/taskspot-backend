import mongoose from "mongoose";

const category = new mongoose.Schema({ key: String, name: String, color: String }, { _id: false });
const task = new mongoose.Schema({
  description: String,
  priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
  categoryKeys: [String],
  checklist: [{ text: String }],
  dueOffsetDays: Number
}, { _id: false });

const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, default: "" },
  categories: [category],
  tasks: [task]
}, { timestamps: true });
schema.index({ owner: 1, createdAt: -1 });
schema.index({ organization: 1 });
export const ProjectTemplate = mongoose.model("ProjectTemplate", schema);
