use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use super::types::GgufMetadata;

const GGUF_MAGIC: [u8; 4] = [0x47, 0x47, 0x55, 0x46]; // "GGUF"

#[derive(Debug)]
pub enum GgufError {
    Io(std::io::Error),
    InvalidMagic,
    UnsupportedVersion(u32),
    ParseError(String),
}

impl From<std::io::Error> for GgufError {
    fn from(err: std::io::Error) -> Self {
        GgufError::Io(err)
    }
}

pub fn parse_gguf_metadata(path: &Path) -> Result<GgufMetadata, GgufError> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(512 * 1024, file);

    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic)?;
    if magic != GGUF_MAGIC {
        return Err(GgufError::InvalidMagic);
    }

    let mut version_buf = [0u8; 4];
    reader.read_exact(&mut version_buf)?;
    let version = u32::from_le_bytes(version_buf);
    if version < 2 || version > 3 {
        return Err(GgufError::UnsupportedVersion(version));
    }

    let mut tensor_count_buf = [0u8; 8];
    reader.read_exact(&mut tensor_count_buf)?;
    let tensor_count = u64::from_le_bytes(tensor_count_buf);

    let mut kv_count_buf = [0u8; 8];
    reader.read_exact(&mut kv_count_buf)?;
    let kv_count = u64::from_le_bytes(kv_count_buf);

    let mut architecture = String::new();
    let mut model_name = None;
    let mut file_type_num = None;
    let mut context_length = None;
    let mut block_count = None;
    let mut embedding_length = None;

    // Read key-value pairs
    for _ in 0..kv_count {
        let key = read_string(&mut reader)?;
        let val_type = read_u32(&mut reader)?;

        match val_type {
            // UINT8
            0 => {
                let mut b = [0u8; 1];
                reader.read_exact(&mut b)?;
            }
            // INT8
            1 => {
                let mut b = [0u8; 1];
                reader.read_exact(&mut b)?;
            }
            // UINT16
            2 => {
                let _ = read_u16(&mut reader)?;
            }
            // INT16
            3 => {
                let _ = read_u16(&mut reader)?;
            }
            // UINT32
            4 => {
                let v = read_u32(&mut reader)?;
                if key == "general.file_type" {
                    file_type_num = Some(v);
                } else if key.ends_with(".context_length") {
                    context_length = Some(v as u64);
                } else if key.ends_with(".block_count") {
                    block_count = Some(v as u64);
                } else if key.ends_with(".embedding_length") {
                    embedding_length = Some(v as u64);
                }
            }
            // INT32
            5 => {
                let _ = read_u32(&mut reader)?;
            }
            // FLOAT32
            6 => {
                let _ = read_u32(&mut reader)?;
            }
            // BOOL
            7 => {
                let mut b = [0u8; 1];
                reader.read_exact(&mut b)?;
            }
            // STRING
            8 => {
                let s = read_string(&mut reader)?;
                if key == "general.architecture" {
                    architecture = s;
                } else if key == "general.name" {
                    model_name = Some(s);
                }
            }
            // ARRAY
            9 => {
                let elem_type = read_u32(&mut reader)?;
                let len = read_u64(&mut reader)?;
                skip_array(&mut reader, elem_type, len)?;
            }
            // UINT64
            10 => {
                let v = read_u64(&mut reader)?;
                if key.ends_with(".context_length") {
                    context_length = Some(v);
                } else if key.ends_with(".block_count") {
                    block_count = Some(v);
                } else if key.ends_with(".embedding_length") {
                    embedding_length = Some(v);
                }
            }
            // INT64
            11 => {
                let _ = read_u64(&mut reader)?;
            }
            // FLOAT64
            12 => {
                let _ = read_u64(&mut reader)?;
            }
            unknown => {
                return Err(GgufError::ParseError(format!("Unknown GGUF value type: {}", unknown)));
            }
        }
    }

    let quantization = file_type_num.map(gguf_file_type_to_str);

    Ok(GgufMetadata {
        architecture: if architecture.is_empty() { "unknown".to_string() } else { architecture },
        name: model_name,
        file_type_description: quantization.clone(),
        quantization,
        context_length,
        block_count,
        embedding_length,
        tensor_count,
        kv_count,
    })
}

fn read_string<R: Read>(reader: &mut R) -> Result<String, GgufError> {
    let len = read_u64(reader)?;
    if len > 10 * 1024 * 1024 {
        return Err(GgufError::ParseError("GGUF string too long".to_string()));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|e| GgufError::ParseError(e.to_string()))
}

fn read_u16<R: Read>(reader: &mut R) -> Result<u16, GgufError> {
    let mut buf = [0u8; 2];
    reader.read_exact(&mut buf)?;
    Ok(u16::from_le_bytes(buf))
}

fn read_u32<R: Read>(reader: &mut R) -> Result<u32, GgufError> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64<R: Read>(reader: &mut R) -> Result<u64, GgufError> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf)?;
    Ok(u64::from_le_bytes(buf))
}

fn skip_bytes(reader: &mut BufReader<File>, bytes: i64) -> Result<(), GgufError> {
    if reader.seek_relative(bytes).is_err() {
        reader.seek(SeekFrom::Current(bytes))?;
    }
    Ok(())
}

fn skip_array(reader: &mut BufReader<File>, elem_type: u32, len: u64) -> Result<(), GgufError> {
    match elem_type {
        0 | 1 | 7 => {
            skip_bytes(reader, len as i64)?;
        }
        2 | 3 => {
            skip_bytes(reader, (len * 2) as i64)?;
        }
        4 | 5 | 6 => {
            skip_bytes(reader, (len * 4) as i64)?;
        }
        10 | 11 | 12 => {
            skip_bytes(reader, (len * 8) as i64)?;
        }
        8 => {
            // Strings: must read each string length and skip
            for _ in 0..len {
                let slen = read_u64(reader)?;
                skip_bytes(reader, slen as i64)?;
            }
        }
        9 => {
            return Err(GgufError::ParseError("Nested arrays in GGUF not supported".to_string()));
        }
        _ => {
            return Err(GgufError::ParseError(format!("Unknown array elem type: {}", elem_type)));
        }
    }
    Ok(())
}

fn gguf_file_type_to_str(ft: u32) -> String {
    match ft {
        0 => "ALL_F32".to_string(),
        1 => "MOSTLY_F16".to_string(),
        2 => "MOSTLY_Q4_0".to_string(),
        3 => "MOSTLY_Q4_1".to_string(),
        7 => "MOSTLY_Q8_0".to_string(),
        8 => "MOSTLY_Q5_0".to_string(),
        9 => "MOSTLY_Q5_1".to_string(),
        10 => "MOSTLY_Q2_K".to_string(),
        11 => "MOSTLY_Q3_K_S".to_string(),
        12 => "MOSTLY_Q3_K_M".to_string(),
        13 => "MOSTLY_Q3_K_L".to_string(),
        14 => "MOSTLY_Q4_K_S".to_string(),
        15 => "MOSTLY_Q4_K_M".to_string(),
        16 => "MOSTLY_Q5_K_S".to_string(),
        17 => "MOSTLY_Q5_K_M".to_string(),
        18 => "MOSTLY_Q6_K".to_string(),
        19 => "MOSTLY_IQ2_XXS".to_string(),
        20 => "MOSTLY_IQ2_XS".to_string(),
        21 => "MOSTLY_Q2_K_S".to_string(),
        22 => "MOSTLY_IQ3_XS".to_string(),
        23 => "MOSTLY_IQ3_XXS".to_string(),
        24 => "MOSTLY_IQ1_S".to_string(),
        25 => "MOSTLY_IQ4_NL".to_string(),
        26 => "MOSTLY_IQ3_S".to_string(),
        27 => "MOSTLY_IQ3_M".to_string(),
        28 => "MOSTLY_IQ2_S".to_string(),
        29 => "MOSTLY_IQ2_M".to_string(),
        30 => "MOSTLY_IQ4_XS".to_string(),
        31 => "MOSTLY_IQ1_M".to_string(),
        32 => "MOSTLY_BF16".to_string(),
        33 => "MOSTLY_Q4_0_4_4".to_string(),
        34 => "MOSTLY_Q4_0_4_8".to_string(),
        35 => "MOSTLY_Q4_0_8_8".to_string(),
        _ => format!("TYPE_{}", ft),
    }
}
