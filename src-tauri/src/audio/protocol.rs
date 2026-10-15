//! Wire format of the `notchbeat-audiotap` helper (see native/audiotap/main.swift).

use std::io::{self, Read};

#[derive(Debug, PartialEq)]
pub enum Message {
    Header { sample_rate: f64, output_latency: f64 },
    Audio { host_time: u64, samples: Vec<f32> },
}

/// Upper bound on one audio message, to reject a corrupt stream instead of allocating wildly.
const MAX_FRAMES: usize = 1 << 16;

pub fn read_message(r: &mut impl Read) -> io::Result<Message> {
    let mut tag = [0u8; 1];
    r.read_exact(&mut tag)?;
    match tag[0] {
        b'H' => Ok(Message::Header { sample_rate: read_f64(r)?, output_latency: read_f64(r)? }),
        b'A' => {
            let mut host = [0u8; 8];
            r.read_exact(&mut host)?;
            let mut count = [0u8; 4];
            r.read_exact(&mut count)?;
            let n = u32::from_le_bytes(count) as usize;
            if n > MAX_FRAMES {
                return Err(io::Error::new(io::ErrorKind::InvalidData, format!("audio message too large: {n} frames")));
            }
            let mut bytes = vec![0u8; n * 4];
            r.read_exact(&mut bytes)?;
            let samples = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            Ok(Message::Audio { host_time: u64::from_le_bytes(host), samples })
        }
        other => Err(io::Error::new(io::ErrorKind::InvalidData, format!("unknown message tag {other:#04x}"))),
    }
}

fn read_f64(r: &mut impl Read) -> io::Result<f64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(f64::from_le_bytes(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn audio(host: u64, samples: &[f32]) -> Vec<u8> {
        let mut v = vec![b'A'];
        v.extend(host.to_le_bytes());
        v.extend((samples.len() as u32).to_le_bytes());
        for s in samples {
            v.extend(s.to_le_bytes());
        }
        v
    }

    #[test]
    fn parses_header_then_audio() {
        let mut bytes = vec![b'H'];
        bytes.extend(48000f64.to_le_bytes());
        bytes.extend(0.012f64.to_le_bytes());
        bytes.extend(audio(99, &[0.5, -0.25]));
        let mut c = Cursor::new(bytes);
        assert_eq!(read_message(&mut c).unwrap(), Message::Header { sample_rate: 48000.0, output_latency: 0.012 });
        assert_eq!(read_message(&mut c).unwrap(), Message::Audio { host_time: 99, samples: vec![0.5, -0.25] });
        assert_eq!(read_message(&mut c).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn rejects_garbage() {
        assert!(read_message(&mut Cursor::new(vec![b'Z'])).is_err());
        let mut huge = vec![b'A'];
        huge.extend(0u64.to_le_bytes());
        huge.extend(u32::MAX.to_le_bytes());
        assert_eq!(read_message(&mut Cursor::new(huge)).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
}
