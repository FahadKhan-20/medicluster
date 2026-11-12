const {defineModel,schema}=require('../db/model');
module.exports=defineModel('CliniqSelection',schema({actor:{type:String,required:true},value:{type:Object,required:true},expiresAt:{type:Date,required:true}},{timestamps:true}));
